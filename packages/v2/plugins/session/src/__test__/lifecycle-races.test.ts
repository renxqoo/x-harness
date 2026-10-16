import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { value, message } from "./helpers";

it("closing the host mid-append rolls back cleanly and leaves no half commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-close-"));
  try {
    const path = join(directory, "data.sqlite");
    const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 5000 } }));
    value(await host.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
    const service = value(host.use(session));
    value(await service.create({ id: "one" }));
    const entries = Array.from({ length: 100 }, (_, index) => ({ kind: "message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(8000) + index }] } }));
    const inflight = service.append({ id: "one", expectedRevision: 0, commitId: "c1", entries });
    setTimeout(() => { void host.close(); }, 5);
    const interrupted = await inflight;
    expect(interrupted.ok).toBe(false);
    expect(await service.get({ id: "one" })).toMatchObject({ ok: false, error: { code: "service-unavailable" } });
    const reopened = value(createHost());
    try {
      value(await reopened.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
      const second = value(reopened.use(session));
      expect(value(await second.get({ id: "one" })).revision).toBe(0);
      expect(await second.getCommit({ id: "one", commitId: "c1" })).toMatchObject({ ok: false, error: { code: "not-found" } });
      value(await second.append({ id: "one", expectedRevision: 0, commitId: "retry", entries: [message("after close")] }));
    } finally { value(await reopened.close()); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

it("closing the host mid-fork never publishes a half child session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-close-fork-"));
  try {
    for (let round = 0; round < 8; round++) {
      const path = join(directory, `d${round}.sqlite`);
      const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 5000 } }));
      value(await host.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
      const service = value(host.use(session));
      value(await service.create({ id: "one" }));
      value(await service.append({ id: "one", expectedRevision: 0, commitId: "seed", entries: Array.from({ length: 50 }, (_, index) => message(`m${index}`)) }));
      const inflight = service.fork({ id: "child", sourceId: "one", throughRevision: 50 });
      setTimeout(() => { void host.close(); }, 2 + round * 3);
      await inflight.catch(() => undefined);
      const reopened = value(createHost());
      try {
        value(await reopened.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
        const second = value(reopened.use(session));
        const child = await second.get({ id: "child" });
        if (child.ok) {
          expect(child.value.revision).toBe(50);
          const history = await second.history({ id: "child", limit: 1 });
          expect(history.ok ? history.value.revision : "failed").toBe(50);
          expect(value(await second.conversation({ id: "child" })).nodes).toHaveLength(50);
        }
      } finally { value(await reopened.close()); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);

it("repeated install and close cycles over one file keep state consistent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-cycles-"));
  try {
    const path = join(directory, "data.sqlite");
    for (let round = 0; round < 20; round++) {
      const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 5000 } }));
      value(await host.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
      const service = value(host.use(session));
      if (round === 0) value(await service.create({ id: "one" }));
      const result = await service.append({ id: "one", expectedRevision: round, commitId: `r${round}`, entries: [message(`round-${round}`)] });
      expect(result.ok ? result.value.revision : result.error.code).toBe(round + 1);
      value(await host.close());
    }
    const final = value(createHost());
    try {
      value(await final.install([value(createSqliteSessionPlugin({ path })), value(createSessionPlugin({ namespace: "lc" }))]));
      expect(value(await value(final.use(session)).get({ id: "one" }))).toMatchObject({ revision: 20 });
      value(await final.close()); value(await final.close());
    } finally { await final.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
