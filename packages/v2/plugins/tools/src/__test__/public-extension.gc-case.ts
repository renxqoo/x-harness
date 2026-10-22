import assert from "node:assert/strict";
import { createHost, definePlugin } from "../../../../core/src/index";
import {
  createToolsPlugin,
  createToolPlugin,
  tools,
  toolAccess,
  toolExecutionAccess,
  toolCatalog,
} from "../index";
import type { ToolAuthorization, ToolCatalogQuery, ToolContribution } from "../index";
import { value, deferred, emptySchema, request, text } from "./helpers";

async function capture() {
  const marker = { bytes: new Uint8Array(4096) },
    entered = deferred(),
    finish = deferred(),
    first = new AbortController(),
    second = new AbortController();
  let allow: ToolAuthorization["allow"] | undefined,
    visit: ToolCatalogQuery["visit"] | undefined,
    entry: ToolContribution | undefined;
  const host = value(createHost());

  try {
    const policy = definePlugin({
      name: "permission",
      requires: { toolAccess, toolExecutionAccess },
      setup(ctx) {
        const base = ctx.guard("toolAccess", () => ({ ok: true, value: { kind: "allow" } }));

        if (!base.ok) return base;

        return ctx.guard("toolExecutionAccess", async (authorization) => {
          allow = authorization.allow;
          authorization.allow({ signal: ctx.signal, revocation: first.signal });
          authorization.allow({ signal: ctx.signal, revocation: second.signal });
          entered.resolve();
          await finish.promise;
          return { ok: true, value: { kind: "allow" } };
        });
      },
    });
    const author = definePlugin({
      name: "catalog",
      requires: { toolCatalog },
      setup: (ctx) => {
        const contribution = {
          signal: ctx.signal,
          tool: { name: "catalog", concurrency: 1, inputSchema: emptySchema },
        };
        entry = contribution;
        return ctx.middleware("toolCatalog", (query, next) => {
          visit = query.visit;
          const sent = query.visit(contribution);
          return sent.ok ? next(query) : sent;
        });
      },
    });
    value(
      await host.install([
        value(createToolsPlugin()),
        policy,
        author,
        value(
          createToolPlugin({
            name: "echo",
            inputSchema: emptySchema,
            execute: async () => text("done"),
          }),
        ),
      ]),
    );
    const service = value(host.use(tools));
    value(await service.list({}));
    const weakEntry = new WeakRef(entry!);
    entry = undefined;
    const pending = service.prepare({
      ...request(),
      onProgress() {
        void marker.bytes;
      },
    });
    await entered.promise;
    first.abort();
    finish.resolve();
    assert.equal((await pending).ok, false);
    return { weakMarker: new WeakRef(marker), weakEntry, retained: { second, allow, visit } };
  } finally {
    finish.resolve();
    value(await host.close());
  }
}

const captured = await capture();
let collected = false;
const deadline = Date.now() + 1000;

do {
  await Bun.sleep(5);
  Bun.gc(true);
  collected = !captured.weakMarker.deref() && !captured.weakEntry.deref();

  if (collected) break;
} while (Date.now() < deadline);

assert.equal(collected, true);
assert.deepEqual(captured.retained.allow!({ signal: captured.retained.second.signal }), {
  ok: true,
  value: { kind: "deny", reason: "access-denied" },
});
assert.equal(captured.retained.visit!({} as never).ok, false);
process.stdout.write("passed\n");
