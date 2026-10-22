import { createHost } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { createToolsPlugin, createToolPlugin } from "../../../tools/src/index";
import { createToolSchedulerPlugin, toolScheduler } from "../index";

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error("unexpected failure");

  return r.value;
}

function consumer() {
  const marker = { bytes: new Uint8Array(4096) };
  return {
    weak: new WeakRef(marker),
    onProgress(this: void) {
      void marker.bytes;
    },
  };
}

function tool(holder: { saved?: (delta: string) => Promise<unknown> }) {
  return value(
    createToolPlugin({
      name: "echo",
      inputSchema: { type: "object" },
      async execute(_i, call) {
        holder.saved = call.progress;
        return { ok: true, value: { content: [] } };
      },
    }),
  );
}

async function run() {
  const observed = consumer(),
    holder: { saved?: (delta: string) => Promise<unknown> } = {};
  const host = value(createHost());
  value(
    await host.install([
      value(createToolsPlugin({ access: "allow" })),
      value(createToolSchedulerPlugin({ access: "allow" })),
      tool(holder),
    ]),
  );
  const service = value(host.use(toolScheduler));
  value(
    await service.execute({
      name: "echo",
      callId: "x",
      input: {},
      onProgress: observed.onProgress,
    }),
  );
  return { weak: observed.weak, holder, host, service };
}

const subject = await run();
const control = (() => {
  const marker = { bytes: new Uint8Array(4096) };
  return new WeakRef(marker);
})();
const deadline = performance.now() + 1000;

do {
  await Bun.sleep(1);
  Bun.gc(true);

  if (!control.deref() && !subject.weak.deref()) break;
} while (performance.now() < deadline);

const report = {
  control: !control.deref(),
  subject: !subject.weak.deref(),
  late: await subject.holder.saved!("late"),
  snapshot: value(await subject.service.inspect({})),
};
value(await subject.host.close());
process.stdout.write(JSON.stringify(report));
