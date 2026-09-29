import { describe, expect, it } from "vitest";
import { fold, runReadyToSettle, step, UnknownEventError } from "../index.ts";
import type { RunSnapshot, TaskSpec, WorkflowEvent } from "../index.ts";

const SPEC: TaskSpec = { description: "d", prompt: "p" };

function base(...events: readonly WorkflowEvent[]): RunSnapshot {
  const made = fold([{ type: "run/created", runId: "r1", parentSession: "s-parent", cwd: "/w" }, ...events]);
  if (made === undefined) throw new Error("fixture must produce snapshot");
  return made;
}

describe("fold：合法主序", () => {
  it("run/created 起卷；终卷前任何事件不得先于它", () => {
    const made = fold([{ type: "run/created", runId: "r1", parentSession: "s", cwd: "/c" }]);
    expect(made).toMatchObject({ runId: "r1", status: "created", consecutiveFailures: 0 });
    expect(() => fold([{ type: "task/submitted", taskId: "t1", spec: SPEC }])).toThrow(/must start with run\/created/);
  });

  it("完整受管旅程：submitted → dispatched → repairing → settled{completed} → notify → run settled", () => {
    const made = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/dispatched", taskId: "t1", agentId: "agent-1", sessionId: "s-child" },
      { type: "task/repair-issued", taskId: "t1", tier: "schema", attempt: 1, violations: ["$.a required"] },
      { type: "task/settled", taskId: "t1", outcome: "completed", verdict: "accept" },
      { type: "notify/delivered", taskId: "t1", to: "s-parent" },
    );
    expect(made.tasks["t1"]).toMatchObject({ status: "settled", outcome: "completed", repairs: 1, agentId: "agent-1" });
    expect(made.notified.has("t1")).toBe(true);
    const ready = runReadyToSettle(made);
    expect(ready).toEqual({ ready: true, outcome: "completed" });
  });

  it("verify 对序：started 计数 → result 回 repairing（裁决留 verdict 层）", () => {
    const made = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/dispatched", taskId: "t1", agentId: "a1", sessionId: "s1" },
      { type: "verify/started", taskId: "t1", tier: "command", attempt: 1 },
      { type: "verify/result", taskId: "t1", tier: "command", attempt: 1, outcome: "failed", exitCode: 1 },
    );
    expect(made.tasks["t1"]).toMatchObject({ status: "repairing", verifyAttempts: 1 });
  });

  it("连续失败计数：failed 计数、completed/取消清零（熔断判定依据）", () => {
    const spec2: TaskSpec = { description: "d", prompt: "p" };
    const made = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/settled", taskId: "t1", outcome: "failed", cause: "child-failed" },
      { type: "task/submitted", taskId: "t2", spec: spec2 },
      { type: "task/settled", taskId: "t2", outcome: "failed", cause: "child-failed" },
      { type: "task/submitted", taskId: "t3", spec: spec2 },
      { type: "task/settled", taskId: "t3", outcome: "cancelled", cause: "task-stop" },
      { type: "task/submitted", taskId: "t4", spec: spec2 },
      { type: "task/settled", taskId: "t4", outcome: "failed", cause: "child-failed" },
    );
    expect(made.consecutiveFailures).toBe(1);
  });
});

describe("fold：后事件收编与幂等（§7）", () => {
  it("task 终态后的 verify/* 落 trailing 不拒（F5——cancel 时命令在飞）", () => {
    const made = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/dispatched", taskId: "t1", agentId: "a1", sessionId: "s1" },
      { type: "task/settled", taskId: "t1", outcome: "cancelled", cause: "task-stop" },
      { type: "verify/started", taskId: "t1", tier: "command", attempt: 1 },
      { type: "verify/result", taskId: "t1", tier: "command", attempt: 1, outcome: "unknown" },
    );
    const task = made.tasks["t1"];
    expect(task?.status).toBe("settled");
    expect(task?.trailing).toHaveLength(2);
  });

  it("重复 task/settled 与 run/settled 幂等（恢复重放同卷安全）", () => {
    const once = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/settled", taskId: "t1", outcome: "completed" },
    );
    const twice = step(once, { type: "task/settled", taskId: "t1", outcome: "completed" });
    expect(twice).toBe(once);
    const runOnce = step(once, { type: "run/settled", outcome: "completed", detail: "" });
    const runTwice = step(runOnce, { type: "run/settled", outcome: "completed", detail: "" });
    expect(runTwice).toBe(runOnce);
  });

  it("settled 后 dispatched（恢复竞态）收编 trailing 不炸", () => {
    const made = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/settled", taskId: "t1", outcome: "failed", cause: "settle-failed" },
      { type: "task/dispatched", taskId: "t1", agentId: "late", sessionId: "late-s" },
    );
    expect(made.tasks["t1"]?.trailing).toHaveLength(1);
    expect(made.tasks["t1"]?.agentId).toBeUndefined();
  });
});

describe("fold：fail-closed 与非法转移", () => {
  it("未知事件类型 throw（词表闭合判别身份）", () => {
    const snapshot = base();
    expect(() => step(snapshot, { type: "task/vaporized" } as unknown as WorkflowEvent)).toThrow(UnknownEventError);
  });

  it("未 submitted 先 dispatched/verify/settled → throw（状态机非法转移）", () => {
    const snapshot = base();
    expect(() => step(snapshot, { type: "task/dispatched", taskId: "ghost", agentId: "a", sessionId: "s" })).toThrow(/unknown task/);
    expect(() => step(snapshot, { type: "verify/started", taskId: "ghost", tier: "command", attempt: 1 })).toThrow(/unknown task/);
    expect(() => step(snapshot, { type: "task/settled", taskId: "ghost", outcome: "completed" })).toThrow(/unknown task/);
  });
});

describe("runReadyToSettle（§10 终局判定）", () => {
  it("全任务终态才 ready；任一 failed → run failed", () => {
    const partial = base(
      { type: "task/submitted", taskId: "t1", spec: SPEC },
      { type: "task/settled", taskId: "t1", outcome: "completed" },
      { type: "task/submitted", taskId: "t2", spec: SPEC },
    );
    expect(runReadyToSettle(partial).ready).toBe(false);
    const allDone = step(partial, { type: "task/settled", taskId: "t2", outcome: "failed", cause: "child-failed" });
    expect(runReadyToSettle(allDone)).toEqual({ ready: true, outcome: "failed" });
  });

  it("空 run 不 ready（created 静默续——恢复表行 1）", () => {
    expect(runReadyToSettle(base()).ready).toBe(false);
  });
});

describe("runReadyToSettle 的 cancelled 语义（T-2 回归：全 cancelled 的 run 曾报 completed）", () => {
  const spec: import("../index.ts").TaskSpec = { description: "d", prompt: "p" };
  it("全 cancelled → run cancelled（非 completed——通知与 run 级 outcome 一致）", () => {
    const made = base(
      { type: "task/submitted", taskId: "t1", spec },
      { type: "task/settled", taskId: "t1", outcome: "cancelled", cause: "task-stop" },
    );
    expect(runReadyToSettle(made)).toEqual({ ready: true, outcome: "cancelled" });
  });
  it("failed 与 cancelled 混合 → run failed（failed 优先——真失败不被取消稀释）", () => {
    const spec2: import("../index.ts").TaskSpec = { description: "d", prompt: "p" };
    const made = base(
      { type: "task/submitted", taskId: "t1", spec },
      { type: "task/settled", taskId: "t1", outcome: "failed", cause: "child-failed" },
      { type: "task/submitted", taskId: "t2", spec: spec2 },
      { type: "task/settled", taskId: "t2", outcome: "cancelled", cause: "dependency-failed" },
    );
    expect(runReadyToSettle(made)).toEqual({ ready: true, outcome: "failed" });
  });
});
