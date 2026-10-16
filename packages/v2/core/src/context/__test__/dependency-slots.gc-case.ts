import { createHost, definePlugin, defineService } from "../../index";
import type { Result } from "../../index";

const value = <T, E>(result: Result<T, E>): T => { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; };
const mode = process.argv[2]; if (!["setup", "map", "service", "kernel"].includes(mode!)) throw new Error("Unknown dependency retention case");
const live = mode === "kernel" ? undefined : value(createHost());

function trackedHost() {
  const marker = { reads: 0 }; const weak = new WeakRef(marker);
  const app = value(createHost({ scheduler: {
    now() { marker.reads++; return performance.now(); },
    delay(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); },
  } }));
  return { app, marker: weak };
}

async function capture(index: number) {
  const { app, marker } = mode === "kernel" ? trackedHost() : { app: live!, marker: undefined };
  const tokens = Array.from({ length: 16 }, (_, item) => value(defineService<{ read(input: string): Promise<Result<string>> }>({ name: `slots/retired-${index}-${item}`, methods: { read: {} } })));
  const output = value(defineService<{ read(input: string): Promise<Result<string>> }>({ name: `slots/output-${index}`, methods: { read: {} } }));
  const requires = Object.fromEntries(tokens.map((token, item) => [`slot${item}`, token])); const weak = [...tokens, output].map((token) => new WeakRef(token)); let held: unknown;
  const installed = value(await app.install([
    definePlugin({ name: "sources", provides: requires, setup(ctx) { return ctx.service(Object.fromEntries(tokens.map((_token, item) => [`slot${item}`, { async read(input: string) { return { ok: true as const, value: input }; } }]))); } }),
    definePlugin({ name: "consumer", requires, provides: { output }, async setup(ctx) {
      if (mode === "setup") { const deps = ctx.deps; value(await deps.slot0!.read("setup")); held = deps; }
      return ctx.service({ output: { async read(input, call) {
        const deps = call.deps; if (Object.keys(deps).length !== 16) throw new Error("Missing dependency slots");
        if (mode === "map") held = deps;
        if (mode === "service" || mode === "kernel") { const source = deps.slot0!; value(await source.read(input)); held = source; }
        return { ok: true, value: input };
      } } });
    } }),
  ]));
  value(await value(app.use(output)).read("capture")); value(await app.uninstall(installed.plugins[0]!, { cascade: true }));
  if (mode === "kernel") value(await app.close());
  return { weak, held, marker };
}
const samples = [];
await capture(0);
for (let index = 1; index <= 8; index++) samples.push(await capture(index));
await capture(9);
for (let turn = 0; turn < 15; turn++) { await Bun.sleep(1); Bun.gc(true); }
const retained = samples.flatMap((sample) => sample.weak).filter((token) => token.deref()).length;
if (retained) throw new Error(`Retired dependency tokens retained: ${retained}`);
if (!samples.every((sample) => sample.held && typeof sample.held === "object")) throw new Error("Dependency handles were not held");
const retainedKernels = samples.filter((sample) => sample.marker?.deref()).length;
if (retainedKernels) throw new Error(`Closed kernels retained: ${retainedKernels}`);
for (const sample of samples) {
  const held = sample.held as Record<string, { read(input: string): Promise<Result<string>> }> & { read(input: string): Promise<Result<string>> };
  const result = mode === "service" || mode === "kernel" ? await held.read("expired") : await held.slot0!.read("expired");
  const expected = mode === "map" ? "cancelled" : "service-unavailable";
  if (result.ok || result.error.code !== expected) throw new Error("Expired dependency changed its failure code");
  if (mode === "map" || mode === "setup") {
    const unused = await held.slot15!.read("expired");
    if (unused.ok || unused.error.code !== "cancelled") throw new Error("Unmaterialized dependency was revived");
  }
}
if (live) value(await live.close()); process.stdout.write(JSON.stringify({ mode, checkedTokens: 136, retained, checkedKernels: mode === "kernel" ? 8 : 0, retainedKernels }) + "\n");
