import { createHost, defineService } from "../../index";
import type { Invocation, Result } from "../../index";

async function makeClosed() {
  const marker = { bytes: new Uint8Array(4096) };
  const weak = new WeakRef(marker);
  const created = createHost({
    onDiagnostic() {
      void marker.bytes;
    },
  });

  if (!created.ok) throw new Error("context failed");

  const registered = created.value.addCleanup(() => ({ ok: true, value: undefined }));

  if (!registered.ok) throw new Error("effect failed");

  const token = defineService<{ run(input: void): Promise<Result<number>> }>({
    name: "memory",
    methods: { run: {} },
  });

  if (!token.ok) throw new Error("definition failed");

  let invocation!: Invocation;
  created.value.register(token.value, {
    run(_input, call) {
      invocation = call;
      return Promise.resolve({ ok: true, value: 1 });
    },
  });
  const service = created.value.use(token.value);

  if (!service.ok) throw new Error("service failed");

  await service.value.run(undefined);
  const task = created.value.startTask({ label: "memory", run: () => ({ ok: true, value: 1 }) });

  if (!task.ok) throw new Error("task failed");

  await created.value.wait(task.value);
  const closed = await created.value.close();

  if (!closed.ok) throw new Error("close failed");

  return { weak, off: registered.value, service: service.value, task: task.value, invocation };
}

const { weak, off, service, task, invocation } = await makeClosed();

for (let iteration = 0; iteration < 10; iteration += 1) {
  await Bun.sleep(1);
  Bun.gc(true);
}

if (weak.deref() !== undefined) throw new Error("Saved disposer retained closed kernel");

if (
  task.state !== "settled" ||
  (await service.run(undefined)).ok ||
  invocation.effect(() => ({ ok: true, value: undefined })).ok
)
  throw new Error("Stale capability was not revoked");

if (typeof off !== "function") throw new Error("Disposer missing");

process.stdout.write("closed kernel collected\n");
