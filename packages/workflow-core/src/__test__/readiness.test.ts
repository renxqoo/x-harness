// 就绪推导单测（件 16 §10）：并发窗、熔断级联、依赖传播（期 2 形态预留验证）。

import { describe, expect, it } from "vitest";
import { dependencyVerdict, fold, readiness } from "../index.ts";
import type { RunSnapshot, TaskOutcome, WorkflowEvent } from "../index.ts";

/** 终态事件工厂（undefined = 未终态） */
const settleOf = (taskId: string, outcome: TaskOutcome | undefined): WorkflowEvent | undefined =>
  outcome === undefined ? undefined : { type: "task/settled", taskId, outcome, cause: outcome === "failed" ? "child-failed" : "task-stop" };

function withTasks(n: number, settled?: (index: number) => WorkflowEvent | undefined): RunSnapshot {
  const events: WorkflowEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({ type: "task/submitted", taskId: `t${String(i + 1)}`, spec: { description: "d", prompt: "p" } });
    const terminal = settled?.(i);
    if (terminal !== undefined) events.push(terminal);
  }
  const made = fold([{ type: "run/created", runId: "r", parentSession: "s", cwd: "/" }, ...events]);
  if (made === undefined) throw new Error("fixture");
  return made;
}

describe("readiness：并发窗与就绪", () => {
  it("空 run：无 dispatchable；熔断不触发", () => {
    const result = readiness(withTasks(0), { maxInFlight: 2, circuitBreak: 3 });
    expect(result).toEqual({ dispatchable: [], dependencyDoomed: [], circuitDoomed: [] });
  });

  it("submitted 且窗未满 → dispatchable；窗满 → 留待下轮", () => {
    const two = withTasks(3);
    const result = readiness(two, { maxInFlight: 2, circuitBreak: 0 });
    expect(result.dispatchable).toEqual(["t1", "t2"]); // 窗 2：前两个就绪
  });

  it("settled 任务不占窗不计就绪", () => {
    const one = withTasks(2, (i) => (i === 0 ? { type: "task/settled", taskId: "t1", outcome: "completed" } : undefined));
    const result = readiness(one, { maxInFlight: 1, circuitBreak: 0 });
    expect(result.dispatchable).toEqual(["t2"]);
  });
});

describe("readiness：熔断（R6——级联取消建议集）", () => {
  it("连续 failed 达阈值 → 全部未终态任务进 circuitDoomed，不再派发", () => {
    const made = withTasks(
      4,
      (i) => (i < 3
        ? { type: "task/settled", taskId: `t${String(i + 1)}`, outcome: "failed", cause: "child-failed" }
        : undefined),
    );
    const result = readiness(made, { maxInFlight: 3, circuitBreak: 3 });
    expect(result.dispatchable).toEqual([]);
    expect(result.circuitDoomed).toEqual(["t4"]); // 未终态任务建议级联取消
  });

  it("failed 计数被取消/完成清零 → 熔断不触发", () => {
    const outcomeAt: ReadonlyArray<TaskOutcome | undefined> = ["failed", "cancelled", "failed", undefined];
    const made = withTasks(4, (i) => settleOf(`t${String(i + 1)}`, outcomeAt[i]));
    // t1 failed(1) → t2 cancelled 清零 → t3 failed(1)：未达 3，不熔断
    const result = readiness(made, { maxInFlight: 3, circuitBreak: 3 });
    expect(result.circuitDoomed).toEqual([]);
    expect(result.dispatchable).toEqual(["t4"]);
  });

  it("circuitBreak=0 = 禁用熔断（连续失败也不级联）", () => {
    const made = withTasks(3, (i) => (i < 2 ? { type: "task/settled", taskId: `t${String(i + 1)}`, outcome: "failed", cause: "child-failed" } : undefined));
    const result = readiness(made, { maxInFlight: 3, circuitBreak: 0 });
    expect(result.circuitDoomed).toEqual([]);
  });
});

describe("readiness：依赖传播（期 2 形态——期 1 spec 无 depends_on 恒就绪）", () => {
  it("期 1 退化：无依赖字段 → 全部 submitted 即就绪", () => {
    const made = withTasks(2);
    const result = readiness(made, { maxInFlight: 5, circuitBreak: 3 });
    expect(result.dispatchable).toHaveLength(2);
    expect(result.dependencyDoomed).toEqual([]);
  });

  it("dependencyVerdict 四值矩阵：空依赖 ready/未终态 waiting/失败终态 doomed/悬空 orphan/全完成 ready", () => {
    const tasks = {
      done: { taskId: "done", spec: { description: "d", prompt: "p" }, status: "settled", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [], outcome: "completed" },
      failed: { taskId: "failed", spec: { description: "d", prompt: "p" }, status: "settled", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [], outcome: "failed" },
      pending: { taskId: "pending", spec: { description: "d", prompt: "p" }, status: "dispatched", repairs: 0, reopens: 0, verifyAttempts: 0, trailing: [] },
    } as const;
    expect(dependencyVerdict([], tasks)).toBe("ready");
    expect(dependencyVerdict(["pending"], tasks)).toBe("waiting");
    expect(dependencyVerdict(["failed"], tasks)).toBe("doomed");
    expect(dependencyVerdict(["ghost"], tasks)).toBe("orphan");
    expect(dependencyVerdict(["done"], tasks)).toBe("ready");
  });
});
