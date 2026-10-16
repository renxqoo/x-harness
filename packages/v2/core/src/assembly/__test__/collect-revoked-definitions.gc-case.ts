import { createHost, defineService } from "../../index";
import type { Result, ServiceToken } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function releaseDefinitions() {
  const host = value(createHost({ limits: { maxDefinitions: 1 } }));
  const child = value(host.createScope({ label: "long-lived" }));
  const weak: WeakRef<object>[] = [];
  for (let index = 0; index < 32; index += 1) {
    let token: ServiceToken<{ run(input: void): Promise<Result<void>> }> | undefined = value(defineService<{ run(input: void): Promise<Result<void>> }>({
      name: `discarded/item-${index}`, methods: { run: {} },
    }));
    weak.push(new WeakRef(token));
    const target = index % 2 === 0 ? host : child;
    const off = value(target.register(token, { run: () => Promise.resolve({ ok: true, value: undefined }) }));
    value(await off());
    token = undefined;
  }
  await Bun.sleep(1);
  return { host, weak };
}

const { host, weak } = await releaseDefinitions();
for (let iteration = 0; iteration < 12; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}
if (weak.some((reference) => reference.deref() !== undefined)) throw new Error(`Revoked definition retained by a live scope: ${weak.flatMap((reference, index) => reference.deref() === undefined ? [] : [index]).join(",")}`);
if (host.inspect().effects !== 0 || host.inspect().scopes !== 2) throw new Error("Long-lived host unexpectedly closed");
value(await host.close());
process.stdout.write("revoked definitions collected\n");
