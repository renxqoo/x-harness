import { createHost, definePlugin, defineService } from "../../../core/src/index";
import type { Result } from "../../../core/src/index";
import { createTimer } from "../index";
import { value } from "./helpers";

function trackedHost() {
  const marker = { bytes: new Uint8Array(4096) };
  return {
    weak: new WeakRef(marker),
    host: value(
      createHost({
        onDiagnostic() {
          void marker.bytes;
        },
      }),
    ),
  };
}

async function capture() {
  const { host, weak } = trackedHost();
  const timers = value(createTimer(host));
  const scheduled = value(timers.timeout({ ms: 0, run: () => ({ ok: true, value: undefined }) }));
  await scheduled.finished;
  value(await host.close());
  return { weak, timers, scheduled };
}

function discardedTool(host: ReturnType<typeof trackedHost>["host"]) {
  const marker = { bytes: new Uint8Array(4096) };
  value(
    createTimer(host, { scheduler: { now: () => marker.bytes.length, delay: () => () => {} } }),
  );
  return new WeakRef(marker);
}

const live = value(createHost());
const discarded = discardedTool(live);

async function retainedPluginTool() {
  const token = value(
    defineService<{ read(input: void): Promise<Result<void>> }>({
      name: "timer/retired",
      methods: { read: {} },
    }),
  );
  const weak = new WeakRef(token);
  let saved!: ReturnType<typeof createTimer>;
  const installed = value(
    await live.install([
      definePlugin({
        name: "provider",
        provides: { token },
        setup(ctx) {
          return ctx.service({
            token: {
              async read() {
                return { ok: true, value: undefined };
              },
            },
          });
        },
      }),
      definePlugin({
        name: "consumer",
        requires: { token },
        setup(ctx) {
          saved = createTimer(ctx);
          return { ok: true, value: undefined };
        },
      }),
    ]),
  );
  value(await live.uninstall(installed.plugins[1]!));
  value(await live.uninstall(installed.plugins[0]!));
  return { weak, saved: value(saved) };
}

const pluginTool = await retainedPluginTool();
const captured = await capture();
await capture();

for (let iteration = 0; iteration < 15; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}

if (discarded.deref() !== undefined)
  throw new Error("Discarded timer helper retained scheduler on a live host");

if (pluginTool.weak.deref() !== undefined)
  throw new Error("Retained timer tool kept an unloaded plugin token alive");

if (pluginTool.saved.timeout({ ms: 0, run: () => ({ ok: true, value: undefined }) }).ok)
  throw new Error("Retired plugin timer accepted work");

value(await live.close());

if (captured.weak.deref() !== undefined) throw new Error("Retained timer held the drained kernel");

if (captured.timers.timeout({ ms: 0, run: () => ({ ok: true, value: undefined }) }).ok)
  throw new Error("Stopped timer accepted work");

if (captured.scheduled.state !== "stopped") throw new Error("Scheduled handle did not settle");

process.stdout.write("collected\n");
