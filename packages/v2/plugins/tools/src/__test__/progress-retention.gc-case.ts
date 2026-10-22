import { createHost } from "../../../../core/src/index";
import { createToolsPlugin, createToolPlugin, tools } from "../index";
import type { Result } from "../../../../core/src/index";

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error("unexpected failure");

  return r.value;
}

async function run(retain: boolean) {
  const marker = { bytes: new Uint8Array(4096) };
  const weak = new WeakRef(marker);
  let saved: ((x: string) => Promise<unknown>) | undefined;
  const host = value(createHost());

  try {
    value(
      await host.install([
        value(createToolsPlugin({ access: "allow" })),
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: { type: "object" },
            async execute(_i, call) {
              if (retain) saved = call.progress;

              return { ok: true, value: { content: [] } };
            },
          }),
        ),
      ]),
    );
    value(
      await value(host.use(tools)).execute({
        name: "echo",
        callId: "a",
        input: {},
        onProgress() {
          void marker.bytes;
        },
      }),
    );
  } finally {
    value(await host.close());
  }

  return { weak, saved };
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
    late: await subject.saved!("late"),
  }),
);
