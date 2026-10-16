import { createHost } from "../../index";
import type { Result } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function close() {
  const marker = { bytes: new Uint8Array(4096) };
  const weak = new WeakRef(marker);
  const host = value(createHost({ limits: { closeTimeoutMs: 50 }, onDiagnostic() { void marker.bytes; } }));
  let resolve!: (result: Result<void>) => void;
  const gate = new Promise<Result<void>>((done) => { resolve = done; });
  const off = value(host.addCleanup(() => gate));
  const result = await Reflect.apply(off, undefined, []) as Result<void>;
  if (result.ok || result.error.code !== "close-incomplete") throw new Error("release deadline missing");
  resolve({ ok: true, value: undefined });
  const disposed = await host.close();
  if (!disposed.ok) throw new Error("dispose did not settle");
  return { weak, off };
}

const control = await close();
const subject = await close();
const again = await Reflect.apply(subject.off, undefined, []) as Result<void>;
if (again.ok || again.error.code !== "close-incomplete") throw new Error("saved handle did not replay its outward result");
const third = await Reflect.apply(subject.off, undefined, []) as Result<void>;
if (third !== again) throw new Error("saved handle is not idempotent after kernel drain");
Bun.gc(true);
if (control.weak.deref() !== undefined) throw new Error("GC control was not collected");
process.stdout.write("manual release handle idempotent\n");
