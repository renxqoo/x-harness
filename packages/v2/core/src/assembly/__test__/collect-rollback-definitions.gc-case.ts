import { createHost, defineService } from "../../index";
import type { Result, ServiceToken } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

async function rollbackWithChildScope() {
  const host = value(createHost());
  const weak: WeakRef<object>[] = [];
  let token: ServiceToken<{ run(input: undefined): Promise<Result<string>> }> | undefined = value(
    defineService<{ run(input: undefined): Promise<Result<string>> }>({
      name: "rollback-child-scope",
      methods: { run: {} },
    }),
  );
  weak.push(new WeakRef(token));
  const failed = await host.install([
    {
      name: "outer",
      provides: {
        token: token as ServiceToken<{ run(input: undefined): Promise<Result<string>> }>,
      },
      async setup(ctx) {
        const provided = ctx.register(
          token as ServiceToken<{ run(input: undefined): Promise<Result<string>> }>,
          { run: () => Promise.resolve({ ok: true as const, value: "x" }) },
        );

        if (!provided.ok) return provided;

        const scope = ctx.createScope({ label: "leak" });

        if (!scope.ok) return scope;

        const local = scope.value.register(
          token as ServiceToken<{ run(input: undefined): Promise<Result<string>> }>,
          { run: () => Promise.resolve({ ok: true as const, value: "y" }) },
          { shadow: true },
        );

        if (!local.ok) return local;

        return { ok: false as const, error: "business" };
      },
    },
  ]);

  if (failed.ok) throw new Error("install must fail");

  token = undefined;
  await host.close();
  await Bun.sleep(1);
  return { weak };
}

const { weak } = await rollbackWithChildScope();

for (let iteration = 0; iteration < 12; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}

if (weak[0]!.deref() !== undefined) throw new Error("definition retained after rollback");

process.stdout.write("definitions collected\n");
