import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import { memoryStorage } from "./memory-storage";
import { value } from "./helpers";
const summary = { id: "one", createdAt: 0, metadata: "null" };
it("malformed catalog pages, nonprogressing cursors and hostile accessors cannot escape backend validation", async () => {
  let result: unknown = { sessions: [] }; let getterCalls = 0; const hostile = Object.defineProperty({}, "sessions", { enumerable: true, get() { getterCalls++; throw new Error("getter"); } });
  const storage = { ...memoryStorage(), async list() { return { ok: true as const, value: result as never }; } }; const host = value(createHost());
  try {
    value(await host.install([definePlugin({ name: "forged-catalog", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage }); } }), value(createSessionPlugin())])); const service = value(host.use(session));
    const cases = [null, [], {}, { sessions: null }, { sessions: [], next: "one" }, { sessions: [summary], next: "zero" }, { sessions: [summary], next: 1 }, { sessions: [summary, summary] }, { sessions: [{ ...summary, id: "z" }, summary] }, { sessions: [{ ...summary, createdAt: -1 }] }, { sessions: [{ ...summary, metadata: "bad" }] }, { sessions: [{ ...summary, parent: { id: "one", revision: 0 } }] }, { sessions: [{ ...summary, parent: { id: "parent", revision: 100001 } }] }, { sessions: [summary], extra: 1 }, hostile];
    for (const malformed of cases) { result = malformed; expect(await service.list({ limit: 2 })).toMatchObject({ error: { code: "storage-corrupt" } }); }
    result = { sessions: [summary] }; expect(await service.list({ after: "default:one" })).toMatchObject({ error: { code: "storage-corrupt" } }); result = { sessions: [summary, { ...summary, id: "two" }] }; expect(await service.list({ limit: 1 })).toMatchObject({ error: { code: "storage-corrupt" } }); expect(getterCalls).toBe(0);
    result = { sessions: [{ ...summary, metadata: `"${"x".repeat(4194304)}"` }] }; expect(await service.list({})).toMatchObject({ error: { code: "storage-corrupt" } });
    result = { sessions: [{ ...summary, parent: undefined }], next: undefined }; expect(value(await service.list({}))).toEqual({ sessions: [{ id: "one", createdAt: 0, metadata: null }] });
    result = { sessions: Array.from({ length: 320 }, (_, index) => ({ ...summary, id: `id-${String(index).padStart(3, "0")}`, metadata: JSON.stringify("x".repeat(15000)) })) }; expect(await service.list({ limit: 320 })).toMatchObject({ error: { code: "record-too-large" } });
  } finally { value(await host.close()); }
});
