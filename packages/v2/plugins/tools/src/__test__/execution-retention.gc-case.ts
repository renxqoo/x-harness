import { createHost, definePlugin } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { execution, createExecutionTarget } from "../../../execution/src/index";
import type { ExecutionFacade } from "../../../execution/src/index";
import { createToolsPlugin, createToolPlugin, tools } from "../index";

function value<T, E>(r: Result<T, E>) {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

async function run(retain: boolean) {
  const marker = { bytes: new Uint8Array(4096) },
    weak = new WeakRef(marker);
  let saved: ExecutionFacade | undefined;
  const host = value(createHost());

  try {
    const provider = definePlugin({
      name: "provider",
      provides: { execution },
      setup: (ctx) =>
        ctx.service({
          execution: {
            async prepare() {
              return createExecutionTarget({
                backend: "test",
                profile: "test",
                argv: ["/bin/echo"],
                cwd: "/",
                env: {},
                resources: [],
                restrictions: {},
              });
            },
            async run() {
              return { ok: true, value: { exitCode: 0, stdout: "ok", stderr: "" } };
            },
          },
        }),
    });
    value(
      await host.install([
        value(createToolsPlugin({ access: "allow" })),
        provider,
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: { type: "object" },
            prepare: async () => ({
              ok: true,
              value: { execution: { profile: "test", argv: ["/bin/echo"] } },
            }),
            async execute(_input, call) {
              if (retain) saved = call.execution;

              return { ok: true, value: { content: [] } };
            },
          }),
        ),
      ]),
    );
    const service = value(host.use(tools));
    const watch = value(
      await service.watch({
        onChange() {
          void marker.bytes;
        },
      }),
    );
    const prepared = value(
      await service.prepare({
        name: "echo",
        callId: "gc",
        input: {},
        onProgress() {
          void marker.bytes;
        },
      }),
    );
    const commit = value(await service.checkPrepared({ prepared }));
    value(await service.executePrepared({ prepared, commit }));
    return { weak, saved, prepared, commit, watch };
  } finally {
    value(await host.close());
  }
}

const control = await run(false),
  subject = await run(true);
const deadline = performance.now() + 1000;

do {
  await Bun.sleep(1);
  Bun.gc(true);

  if (!control.weak.deref() && !subject.weak.deref()) break;
} while (performance.now() < deadline);

process.stdout.write(
  JSON.stringify({
    control: !control.weak.deref(),
    subject: !subject.weak.deref(),
    late: await subject.saved!.run(),
    status: subject.prepared.status(),
  }),
);
