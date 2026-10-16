import { createHost, defineService } from "../../index";
import type { DependencyContext, Result, Host, TaskHandle } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function capability(caseName: string, retain: boolean) {
  const marker = { bytes: new Uint8Array(4096) };
  const weak = new WeakRef(marker);
  const host = value(createHost({ onDiagnostic() { void marker.bytes; } }));
  let saved: DependencyContext | undefined;
  if (caseName === "bound") {
    const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "review/bound-gc", methods: { run: {} } }));
    value(host.register(token, { run(_input, call) { saved = value(call.bind(host)); return Promise.resolve({ ok: true, value: undefined }); } }));
    await value(host.use(token)).run(undefined);
  } else if (caseName === "plugin") {
    value(await host.install([{ name: "retained-context", setup(ctx) { saved = ctx; return { ok: true, value: undefined }; } }]));
  } else {
    value(host.addCleanup((call) => { saved = call.context; return { ok: true, value: undefined }; }));
  }
  value(await host.close());
  return { weak, saved: retain ? saved : undefined };
}

async function subscribe<T, E>(host: Host, task: TaskHandle<T, E>, retain: boolean) {
  const marker = { bytes: new Uint8Array(4096) };
  const weak = new WeakRef(marker);
  const signal = new AbortController().signal;
  signal.addEventListener("abort", () => { void marker.bytes; });
  if (retain) await host.wait(task, { signal, timeoutMs: 1 });
  return { weak };
}

async function definition(host: Host, options: { retain: boolean; name: string }) {
  const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: options.name, methods: { run: {} } }));
  const weak = new WeakRef(token);
  if (options.retain) {
    const off = value(host.register(token, { run() { return Promise.resolve({ ok: true, value: undefined }); } }));
    value(await off());
  }
  return { weak };
}

const caseName = process.argv[2]!;
let release: (() => void) | undefined;
let host: Host | undefined;
let control: { weak: WeakRef<object>; saved?: DependencyContext };
let subject: { weak: WeakRef<object>; saved?: DependencyContext };
const retired: WeakRef<object>[] = [];
if (caseName === "wait") {
  host = value(createHost());
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const task = value(host.startTask({ label: "gc-target", async run() { await gate; return { ok: true, value: undefined }; } }));
  control = await subscribe(host, task, false);
  subject = await subscribe(host, task, true);
} else if (caseName === "tombstone") {
  host = value(createHost({ limits: { maxDefinitions: 1 } }));
  control = await definition(host, { retain: false, name: "review/control" });
  subject = await definition(host, { retain: true, name: "review/retired" });
  for (let index = 0; index < 32; index += 1) retired.push((await definition(host, { retain: true, name: `review/retired-${index}` })).weak);
} else {
  control = await capability(caseName, false);
  subject = await capability(caseName, true);
}
for (let iteration = 0; iteration < 15; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}
process.stdout.write(JSON.stringify({ controlCollected: control.weak.deref() === undefined, subjectCollected: subject.weak.deref() === undefined && retired.every((weak) => weak.deref() === undefined), retainedDefinitions: retired.filter((weak) => weak.deref() !== undefined).length }));
void subject.saved;
release?.();
if (host) await host.close();
