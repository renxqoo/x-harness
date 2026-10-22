import { createHost, definePlugin, defineService } from "../core/src/index";
import type { Result } from "../core/src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));

  return result.value;
}

const collect = process.argv.includes("--collect");

if (collect && process.env.BUN_JSC_useJIT !== "false")
  throw new Error(
    "Collection checks require BUN_JSC_useJIT=false to isolate conservative JIT roots",
  );

const app = value(createHost({ limits: { maxDefinitions: 1 } }));
const weak: WeakRef<object>[] = [];
let acquired = 0;
let released = 0;
const start = performance.now();

async function rotate(index: number) {
  const token = value(
    defineService<{ run(input: number): Promise<Result<number>> }>({
      name: `rotation/item-${index}`,
      methods: { run: {} },
    }),
  );

  if (collect) weak.push(new WeakRef(token));

  const loaded = value(
    await app.install([
      definePlugin({
        name: "provider",
        provides: { token },
        async setup(ctx) {
          const resource = await ctx.resource({
            open() {
              acquired++;
              return { ok: true, value: index };
            },
            close() {
              released++;
              return { ok: true, value: undefined };
            },
          });

          if (!resource.ok) return resource;

          return ctx.service({
            token: {
              async run(input) {
                return { ok: true, value: input + resource.value };
              },
            },
          });
        },
      }),
    ]),
  );
  const saved = value(app.use(token));

  if (value(await saved.run(1)) !== index + 1) throw new Error("wrong result");

  value(await app.uninstall(loaded.plugins[0]!));

  if ((await saved.run(1)).ok) throw new Error("revoked generation revived");

  const report = app.inspect();

  if (
    report.effects ||
    report.activeCalls ||
    report.activeTasks ||
    report.serviceLeases ||
    report.pendingEvents ||
    report.activeWaits ||
    report.plugins.length ||
    report.scopes !== 1 ||
    acquired !== released
  )
    throw new Error(JSON.stringify(report));
}

for (let index = 0; index < 10_000; index++) {
  await rotate(index);

  if ((index + 1) % 1000 === 0) {
    await Bun.sleep(1);
    Bun.gc(true);
    process.stdout.write(
      JSON.stringify({
        rotations: index + 1,
        elapsedMs: performance.now() - start,
        heapUsed: process.memoryUsage().heapUsed,
        acquired,
        released,
      }) + "\n",
    );
  }
}

for (let index = 0; index < 12; index++) {
  await Bun.sleep(1);
  Bun.gc(true);
}

const retained = weak.filter((ref) => ref.deref() !== undefined).length;

if (retained) throw new Error(`${retained} tokens retained`);

value(await app.close());
process.stdout.write(
  JSON.stringify({
    retained,
    inspection: app.inspect(),
    runtime: Bun.version,
    collect,
    platform: process.platform,
    arch: process.arch,
  }) + "\n",
);
