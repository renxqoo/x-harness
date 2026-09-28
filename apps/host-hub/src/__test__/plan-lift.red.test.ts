// 红测（对抗审查——b85e043 宿主面）：hub assembly planKit liftTo 缺省病。
//
// assembly.ts:415 `...planKit({ liftTo: fields.permissionMode ?? "auto" })`——
// liftTo 直接取会话权限档初值。当线程以 plan 档开线（thread/start permissionMode
// 入参 / thread/resume 显式入参 / hub-settings permission.defaultMode=plan）时
// liftTo === "plan"：plan_submit 批准后 mode.set("plan") 是 no-op，工具回文却宣称
// "plan mode lifted ... Proceed with the implementation"——模型随即尝试写入，
// 又被 plan-deny 拒。审批协议件在「以 plan 开线」这一主姿势下失效。
//
// 本文件断言「批准后应离开 plan 档」——现状为红即坐实设计 bug。

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
      // 病灶触发条件：thread/start 的 permissionMode 入参（词表校验放行 plan）
      permissionMode: "plan",
      // 用户批准方案（ui_request confirm → permissionBroker allow）
      confirm: async () => ({ allowed: true }),
    });
    try {
      const svc = assembled.world.ctx.tryUse(permissionMode);
      expect(svc).toBeDefined();
      expect(svc?.get()).toBe("plan"); // 装配起点：plan（fenceKit mode 同源）
      const out = await assembled.world.registry.dispatch({
        callId: "planlift-1",
        name: "plan_submit",
        args: { plan: "step 1: read the parser; step 2: refactor it" },
        signal: new AbortController().signal,
        session: assembled.sessionId as never,
      });
      expect(out.isError).not.toBe(true); // broker 批准路径本身通（绿）
      expect(String(out.content)).toContain("plan mode lifted"); // 现状：回文宣称已解档（欺骗面）
      expect(svc?.get()).not.toBe("plan"); // 红——实际档位仍为 "plan"
    } finally {
      await assembled.handle.dispose().catch(() => undefined);
      await teardownWorld(assembled.world).catch(() => undefined);
    }
  }, 30_000);
});
