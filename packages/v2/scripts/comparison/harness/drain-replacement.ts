import { createApplication } from "../../../application/src/index";
import { definePlugin, defineService } from "../../../core/src/index";
import type { Endpoint } from "../types";
import { defer } from "../defer";
import { unwrap } from "../unwrap";
import { settle } from "../settle";

export async function drainReplacement() {
  const source = unwrap(defineService<Endpoint>({ name: "journey/in-flight", methods: { read: {} } }));
  const app = unwrap(createApplication()); const started = defer(); const stopping = defer(); const gate = defer(); let closed = false; let bodySawClosed = false;
  const old = definePlugin({ name: "provider", provides: { source }, async setup(ctx) {
    const resource = await ctx.resource({ open: () => ({ ok: true, value: {} }), close: () => { closed = true; return { ok: true, value: undefined }; } }); if (!resource.ok) return resource;
    return ctx.service({ source: { async read(_input, call) {
      call.signal.addEventListener("abort", () => stopping.resolve(), { once: true }); started.resolve();
      await gate.promise; bodySawClosed = closed; return { ok: true, value: "old" };
    } } });
  } });
  const next = definePlugin({ name: "provider", provides: { source }, setup(ctx) { return ctx.service({ source: { async read() { return { ok: true, value: "new" }; } } }); } });
  try {
    unwrap(await app.setPlugins([old])); const saved = unwrap(app.use(source)); const pending = saved.read("start"); await started.promise;
    let replaced = false; const replacing = app.setPlugins([next]).then((result) => { replaced = true; return result; });
    await stopping.promise; await settle(); const closedBeforeGate = closed; const replacementSettledBeforeGate = replaced;
    gate.resolve(); unwrap(await replacing); await pending; const observed = bodySawClosed; const stale = await saved.read("stale");
    return { closedBeforeGate, replacementSettledBeforeGate, bodySawClosed: observed, savedEntryBlocked: !stale.ok, next: unwrap(await unwrap(app.use(source)).read("next")) };
  } finally { gate.resolve(); unwrap(await app.close()); }
}
