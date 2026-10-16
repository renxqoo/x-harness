import { createHost, defineEvent, definePlugin } from "../../../core/src/index";
import type { EmitReceipt, Result } from "../../../core/src/index";
import { defer } from "../defer";
import { unwrap } from "../unwrap";

export async function deliverEvent() {
  const changed = unwrap(defineEvent<string>({ name: "journey/change", payload: (input) => typeof input === "string" ? { ok: true, value: input } : { ok: false, error: { source: "core", code: "invalid-input", message: "text" } } }));
  const host = unwrap(createHost()); const delivered = defer(); const values: string[] = []; let publish!: (value: string) => Result<EmitReceipt>;
  try {
    unwrap(await host.install([
      definePlugin({ name: "publisher", provides: { changed }, setup(ctx) { publish = (value) => ctx.emit("changed", value); return { ok: true, value: undefined }; } }),
      definePlugin({ name: "listener", requires: { changed }, setup(ctx) { return ctx.on("changed", async (value) => { values.push(value); delivered.resolve(); }); } }),
    ]));
    unwrap(publish("changed")); await delivered.promise; return values;
  } finally { unwrap(await host.close()); }
}
