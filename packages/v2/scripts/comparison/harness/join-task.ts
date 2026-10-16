import { createHost, definePlugin } from "../../../core/src/index";
import { defer } from "../defer";
import { settle } from "../settle";
import { unwrap } from "../unwrap";

export async function joinTask() {
  const host = unwrap(createHost()); const started = defer(); const gate = defer(); const aborted = defer(); let finished = 0; let cancelled = false;
  try {
    unwrap(await host.install([definePlugin({ name: "task", setup(ctx) { return ctx.startTask({ label: "refresh", async run(call) {
      call.signal.addEventListener("abort", () => aborted.resolve(), { once: true }); started.resolve();
      await gate.promise; cancelled = call.signal.aborted; finished++; return { ok: true, value: undefined };
    } }); } })]));
    await started.promise; let closed = false; const closing = host.close().then((result) => { unwrap(result); closed = true; });
    await aborted.promise; await settle(); const closeWaited = !closed;
    gate.resolve(); await closing;
    return { finished, cancelled, closeWaited };
  } finally { gate.resolve(); unwrap(await host.close()); }
}
