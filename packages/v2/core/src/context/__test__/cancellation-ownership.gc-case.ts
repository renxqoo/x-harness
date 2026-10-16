import { createHost } from "../../index";
import type { Invocation, Result } from "../../index";

function value<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error("Unexpected failure"); return result.value; }
const ok = (): Result<void> => ({ ok: true, value: undefined });
const host = value(createHost());
const mode = process.argv[2] ?? "normal";

function listen(signal: AbortSignal, marker: object) { signal.addEventListener("abort", () => { void marker; }); }

async function completed() {
  const marker = { bytes: new Uint8Array(4096) }; const weak = new WeakRef(marker); let signal!: AbortSignal;
  const task = value(host.startTask({ label: "listener", run(call) { signal = call.signal; listen(signal, marker); return ok(); } }));
  await task.finished; return { marker: weak, signal: new WeakRef(signal) };
}

async function cancelled() {
  const reason = { bytes: new Uint8Array(4096) }; const weak = new WeakRef(reason); const source = new AbortController(); let call!: Invocation; let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const task = value(host.startTask({ label: "reason", signal: source.signal, async run(current) { call = current; await gate; return ok(); } }));
  await Bun.sleep(0);
  const dependent = mode === "native-any" ? AbortSignal.any([call.signal, source.signal]) : undefined;
  source.abort(reason); finish(); await task.finished;
  return { marker: weak, call, dependent, retained: mode === "retain-source" ? source : undefined };
}

async function closed() {
  const marker = { bytes: new Uint8Array(4096) }; const weak = new WeakRef(marker);
  const app = value(createHost({ scheduler: { now: () => performance.now() + marker.bytes[0]!, delay(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); } } }));
  const signal = app.signal; const task = value(app.startTask({ label: "closed", run: ok })); await task.finished; value(await app.close());
  return { marker: weak, signal };
}

const successful = await completed(); await completed();
await cancelled();
const aborted = [];
for (let index = 0; index < 8; index++) aborted.push(await cancelled());
await cancelled();
const stopped = await closed(); await closed();
for (let i = 0; i < 20; i++) { await Bun.sleep(1); Bun.gc(true); }
if (successful.marker.deref() || successful.signal.deref()) throw new Error("Live owner retained completed work or its business listener");
if (aborted.some((entry) => entry.marker.deref())) throw new Error("Saved invocation retained the raw external cancellation reason");
if (stopped.marker.deref()) throw new Error("Saved closed owner signal retained its kernel");
if (aborted.some((entry) => !entry.call.signal.aborted) || !stopped.signal.aborted) throw new Error("Cancellation signal did not remain cancelled");
if (aborted.some((entry) => !(entry.call.signal.reason instanceof DOMException))) throw new Error("External reason escaped into the work signal");
value(await host.close()); process.stdout.write("collected\n");
