// 深度审计高优修复回归（校准数学/接管还权/softInject——改回去这些测试必须红）

import { describe, expect, it } from "vitest";
import { updateCalibration } from "../gate.ts";
import { makeSessionState } from "../session-state.ts";
import { calibrationFactor } from "../calibration.ts";
import type { SessionId } from "@x-harness/session";

describe("审计问题 1 回归：校准配对分子必须是 LLM 实报锚", () => {
  it("trailing=100 gain=50 anchor=800 lastEstimated=500 → ratio=800/500=1.6（不是 100/500=0.2）", () => {
    const state = makeSessionState("cal-1" as SessionId);
    // 第一步：无锚——存纯预测
    updateCalibration(state.cache, { trailingTokens: 400, gainTokens: 100, hasAnchor: false, anchorTokens: 0 });
    expect(state.cache.lastEstimated).toBe(500);
    // 第二步：锚到达——ratio = anchorTokens / lastEstimated = 800/500
    updateCalibration(state.cache, { trailingTokens: 100, gainTokens: 50, hasAnchor: true, anchorTokens: 800 });
    // 中位因子应该在 1.6 附近（只有一个样本时中位=样本值）
    const factor = calibrationFactor(state.cache.calibration);
    expect(factor).toBeGreaterThan(1.5); // 如果分子错用了 trailing(100)，factor 会是 0.2
    expect(factor).toBeLessThan(1.7);
    expect(state.cache.lastEstimated).toBeUndefined(); // 配对一次性消耗
  });

  it("配对后 lastEstimated 清空——第三步再推新预测", () => {
    const state = makeSessionState("cal-2" as SessionId);
    updateCalibration(state.cache, { trailingTokens: 300, gainTokens: 0, hasAnchor: false, anchorTokens: 0 });
    expect(state.cache.lastEstimated).toBe(300);
    updateCalibration(state.cache, { trailingTokens: 50, gainTokens: 0, hasAnchor: true, anchorTokens: 600 });
    expect(state.cache.lastEstimated).toBeUndefined();
    updateCalibration(state.cache, { trailingTokens: 200, gainTokens: 20, hasAnchor: false, anchorTokens: 0 });
    expect(state.cache.lastEstimated).toBe(220); // 新预测
  });

  it("anchorTokens=0 时不推样本（防零除）", () => {
    const state = makeSessionState("cal-3" as SessionId);
    updateCalibration(state.cache, { trailingTokens: 100, gainTokens: 0, hasAnchor: false, anchorTokens: 0 });
    updateCalibration(state.cache, { trailingTokens: 50, gainTokens: 0, hasAnchor: true, anchorTokens: 0 });
    // 不应崩溃；因子仍是缺省
    expect(calibrationFactor(state.cache.calibration)).toBeGreaterThan(0);
  });
});

describe("审计问题 2 回归：Occupancy 暴露纯 anchorTokens", () => {
  it("measureContext 返回 anchorTokens（不含 trailing×factor 污染）", async () => {
    const { measureContext } = await import("@x-harness/compaction");
    const { sessionPlugin, sessionStore } = await import("@x-harness/session");
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin]);
    const store = ctx.use(sessionStore);
    const made = await store.create({ id: "occ-1" as never });
    if (!made.ok) throw new Error(made.reason);
    const session = made.value;
    // 无 assistant 锚 → anchorTokens=0
    session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "hello" }] }, { surfaceOp: "append" } as never);
    const occ1 = measureContext(session.events(), session.surface());
    expect(occ1.anchorTokens).toBe(0);
    expect(occ1.hasAnchor).toBe(false);
    // 有 assistant 锚（usage.input=123）→ anchorTokens=123
    const appendResult = session.append("assistant/message", { turn: 0, step: 0, content: [{ type: "text", text: "hi" }], usage: { input: 123, output: 5 }, stopReason: "stop" }, { surfaceOp: "append" } as never);
    if (!appendResult.ok) throw new Error(appendResult.reason);
    const occ2 = measureContext(session.events(), session.surface());
    expect(occ2.hasAnchor).toBe(true);
    expect(occ2.anchorTokens).toBe(123); // 纯值——不含 trailing×factor
    await ctx.dispose();
  });
});
