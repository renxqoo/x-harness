import { createHost, defineService } from "../../index";
import type { Result } from "../../index";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error("Unexpected failure");

  return result.value;
}

function trackedHost() {
  const marker = { bytes: new Uint8Array(4096) };
  const host = value(
    createHost({
      onDiagnostic() {
        void marker.bytes;
      },
    }),
  );
  return { host, weakKernel: new WeakRef(marker) };
}

async function capture(mode: string) {
  const { host, weakKernel } = trackedHost();
  const token = value(
    defineService<{ run(input: void): Promise<Result<void>> }>({
      name: "diagnostic/storage",
      methods: { run: {} },
    }),
  );
  const weakToken = new WeakRef(token);
  const installed = value(
    await host.install([
      {
        name: "storage",
        provides: { token },
        setup(ctx) {
          return ctx.register(token, {
            run() {
              return Promise.resolve({ ok: true, value: undefined });
            },
          });
        },
      },
      {
        name: "consumer",
        requires: { token },
        setup(ctx) {
          return ctx.resource({
            open: () => ({ ok: true, value: { bytes: new Uint8Array(4096) } }),
            close: () => ({ ok: true, value: undefined }),
          });
        },
      },
    ]),
  );
  const snapshot = host.inspect();
  const blocked = await host.uninstall(installed.plugins[0]!);
  const diagnostics = host.diagnostics();
  value(await host.uninstall(installed.plugins[0]!, { cascade: true }));

  if (mode === "closed") value(await host.close());

  return {
    weakToken,
    weakKernel,
    metadata: { snapshot, blocked, diagnostics },
    host: mode === "live" ? host : undefined,
  };
}

const mode = process.argv[2]!;
const captured = await capture(mode);

for (let iteration = 0; iteration < 15; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}

process.stdout.write(
  JSON.stringify({
    tokenCollected: captured.weakToken.deref() === undefined,
    kernelCollected: captured.weakKernel.deref() === undefined,
  }),
);

if (
  captured.metadata.snapshot.plugins.length !== 2 ||
  captured.metadata.blocked.ok ||
  captured.metadata.diagnostics.length !== 1
)
  throw new Error("Snapshot was not retained");

if (captured.host) value(await captured.host.close());
