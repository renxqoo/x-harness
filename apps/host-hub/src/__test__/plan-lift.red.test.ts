import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionMode } from "@x-harness/permission";
import { assembleWorkerAgent, teardownWorld } from "../worker/assembly.ts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe("hub planKit liftTo（plan 档开线——解档出口）", () => {
  test("permissionMode=plan 装配 + 用户批准：plan_submit 应解档（红——liftTo 即 plan，set 为 no-op）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hub-planlift-"));
    roots.push(dir);
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(dir, "sessions"),
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: {
        HUB_WORKER_PROVIDER: "script",
        HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]),
        X_HARNESS_MAILBOX_DIR: join(dir, "mailbox"),
        X_HARNESS_WORKFLOW_DIR: join(dir, "workflows"),
      },
      permissionMode: "plan",
      confirm: async () => ({ allowed: true }),
    });
    try {
      const svc = assembled.world.ctx.tryUse(permissionMode);
      expect(svc).toBeDefined();
      expect(svc?.get()).toBe("plan");
      const out = await assembled.world.registry.dispatch({
        callId: "planlift-1",
        name: "plan_submit",
        args: { plan: "step 1: read the parser; step 2: refactor it" },
        signal: new AbortController().signal,
        session: assembled.sessionId as never,
      });
      expect(out.isError).not.toBe(true);
      expect(String(out.content)).toContain("plan mode lifted");
      expect(svc?.get()).not.toBe("plan");
    } finally {
      await assembled.handle.dispose().catch(() => undefined);
      await teardownWorld(assembled.world).catch(() => undefined);
    }
  }, 30_000);
});
