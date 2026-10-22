import { createHost, definePlugin, defineService } from "../../index";
import type { PluginContext, PluginInvocation, Result } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Unexpected failure");

  return result.value;
}

const ok = (): Result<void> => ({ ok: true, value: undefined });

const host = value(createHost());

async function capture() {
  const token = value(
    defineService<{ read(input: void): Promise<Result<void>> }>({
      name: "derived/token",
      methods: { read: {} },
    }),
  );
  const weak = new WeakRef(token);
  let saved!: PluginContext<{ requires: { token: typeof token } }>;
  let invocation!: PluginInvocation<{ requires: { token: typeof token } }>;
  const provider = definePlugin({
    name: "provider",
    provides: { token },
    setup(ctx) {
      return ctx.service({
        token: {
          async read() {
            return ok();
          },
        },
      });
    },
  });
  const consumer = definePlugin({
    name: "consumer",
    requires: { token },
    setup(ctx) {
      saved = ctx;
      return ctx.startTask({
        label: "derive",
        run(call) {
          invocation = call;
          return ok();
        },
      });
    },
  });
  const installed = value(await host.install([provider, consumer]));
  value(await host.uninstall(installed.plugins[1]!));
  value(await host.uninstall(installed.plugins[0]!));
  return { weak, saved, invocation };
}

const captured = await capture();

for (let turn = 0; turn < 15; turn += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}

if (captured.weak.deref()) throw new Error("Retired derived capabilities retained token");

if ((await captured.saved.deps.token.read()).ok || (await captured.invocation.deps.token.read()).ok)
  throw new Error("Retired dependency accepted work");

if (captured.saved.addCleanup(ok).ok) throw new Error("Retired context accepted cleanup");

value(await host.close());
process.stdout.write("collected\n");
