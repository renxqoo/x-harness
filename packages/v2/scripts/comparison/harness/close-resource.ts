import assert from "node:assert/strict";
import { createHost, definePlugin } from "../../../core/src/index";
import { unwrap } from "../unwrap";

export async function closeResource() {
  const host = unwrap(createHost()); let opened = 0; let closed = 0;
  try {
    unwrap(await host.install([definePlugin({ name: "resource", async setup(ctx) {
      return ctx.resource({ async open() { opened++; return { ok: true, value: { name: "connection" } }; }, async close(connection) { assert.equal(connection.name, "connection"); closed++; return { ok: true, value: undefined }; } });
    } })]));
    assert.equal(closed, 0);
  } finally { unwrap(await host.close()); }
  return { opened, closed };
}
