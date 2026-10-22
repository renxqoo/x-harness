import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { sessionStorage } from "../storage";
import type { SessionStorage } from "../storage";
import { memoryStorage } from "./memory-storage";
import { value, message } from "./helpers";

it("append idempotency rejects a stored receipt that does not match the retried request", async () => {
  const storage = memoryStorage();
  const forged: SessionStorage = {
    ...storage,
    async read(input) {
      const snapshot = await storage.read(input);

      if (!snapshot.ok || !snapshot.value.commit || input.commitId === undefined) return snapshot;

      const commit = snapshot.value.commit;
      return {
        ok: true,
        value: {
          ...snapshot.value,
          commit: {
            ...commit,
            receipt: { ...commit.receipt, firstSeq: 99, lastSeq: 99, revision: 99 },
          },
        },
      };
    },
  };
  const host = value(createHost());

  try {
    value(
      await host.install([
        value(createSessionPlugin()),
        definePlugin({
          name: "forged-receipt-store",
          provides: { storage: sessionStorage },
          setup(ctx) {
            return ctx.service({ storage: forged });
          },
        }),
      ]),
    );
    const service = value(host.use(session));
    value(await service.create({ id: "one" }));
    const input = { id: "one", expectedRevision: 0, commitId: "c1", entries: [message("a")] };
    value(await service.append(input));
    expect(await service.append(input)).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });
  } finally {
    value(await host.close());
  }
});

it("fork idempotency rejects a stored head that does not match the retried fork identity", async () => {
  const storage = memoryStorage();
  const forged: SessionStorage = {
    ...storage,
    async read(input) {
      const snapshot = await storage.read(input);

      if (!snapshot.ok || input.id !== "child") return snapshot;

      return {
        ok: true,
        value: {
          ...snapshot.value,
          head: {
            ...snapshot.value.head,
            revision: 42,
            bytes: 9999,
            parent: { id: "evil", revision: 42 },
          },
        },
      };
    },
  };
  const host = value(createHost());

  try {
    value(
      await host.install([
        value(createSessionPlugin()),
        definePlugin({
          name: "forged-fork-store",
          provides: { storage: sessionStorage },
          setup(ctx) {
            return ctx.service({ storage: forged });
          },
        }),
      ]),
    );
    const service = value(host.use(session));
    value(await service.create({ id: "src" }));
    value(
      await service.append({
        id: "src",
        expectedRevision: 0,
        commitId: "c1",
        entries: [message("a")],
      }),
    );
    value(await service.fork({ id: "child", sourceId: "src", throughRevision: 1 }));
    expect(await service.fork({ id: "child", sourceId: "src", throughRevision: 1 })).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });
  } finally {
    value(await host.close());
  }
});
