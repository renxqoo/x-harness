import { createApplication } from "../../../application/src/index";
import { definePlugin, defineService } from "../../../core/src/index";
import type { Endpoint } from "../types";
import { unwrap } from "../unwrap";

export async function replaceProvider() {
  const version = unwrap(
    defineService<Endpoint>({ name: "journey/version", methods: { read: {} } }),
  );
  const client = unwrap(defineService<Endpoint>({ name: "journey/client", methods: { read: {} } }));
  const app = unwrap(createApplication());
  const cleanup: string[] = [];
  let starts = 0;

  const provider = (label: string) =>
    definePlugin({
      name: "provider",
      provides: { version },
      setup(ctx) {
        const effect = ctx.addCleanup(() => {
          cleanup.push(`provider:${label}`);
          return { ok: true, value: undefined };
        });

        if (!effect.ok) return effect;

        return ctx.service({
          version: {
            async read() {
              return { ok: true, value: label };
            },
          },
        });
      },
    });

  const consumer = definePlugin({
    name: "consumer",
    requires: { version },
    provides: { client },
    setup(ctx) {
      starts++;
      const effect = ctx.addCleanup(() => {
        cleanup.push("consumer");
        return { ok: true, value: undefined };
      });

      if (!effect.ok) return effect;

      return ctx.service({
        client: {
          async read(input, call) {
            return call.deps.version.read(input);
          },
        },
      });
    },
  });

  try {
    unwrap(await app.setPlugins([consumer, provider("old")]));
    const saved = unwrap(app.use(client));
    const before = unwrap(await saved.read("before"));
    unwrap(await app.setPlugins([consumer, provider("new")]));
    const after = unwrap(await unwrap(app.use(client)).read("after"));
    const stale = await saved.read("saved");
    return {
      before,
      after,
      starts,
      cleanup: [...cleanup],
      savedEntry: stale.ok ? stale.value : "revoked",
    };
  } finally {
    unwrap(await app.close());
  }
}
