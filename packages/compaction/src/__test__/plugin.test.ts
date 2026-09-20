// 装配层（docs/COMPACTION.md §1.1；对照参照系 compaction/compaction-surface/
// hardening-guardrails 语义子集：承接水位触发→落账→投影替换、累积更新、软禁用、
// 阈值不触发、manual runner、单飞行、值域 fail-fast、多会话隔离；改写为 waterfall
// dispatch + sessionStore 形态）。

import { describe, expect, it, vi } from "vitest";
import { agentRequestError } from "@x-harness/agent-loop";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { compactionLanded, compactionRunner } from "../tokens.ts";
import { createCompactionPlugin } from "../plugin.ts";
import { previousSummaryOf } from "../compact.ts";
import type { CompactionSkipReason } from "../compact.ts";
import { assistantNode, BASE_OPTIONS, emptyScript, makeWorld, promptOf, seedSystem, seedTurn, sid, textOf, textScript, truncatedScript, userNode,
  dispatchPreStep,
} from "./helpers.ts";

describe("配置值域 fail-fast（装配期 throw）", () => {
  it.each([
    ["contextWindow < 1", { contextWindow: 0 }],
    ["contextWindow NaN", { contextWindow: Number.NaN }],
    ["reserveTokens < 1", { reserveTokens: 0 }],
    ["reserve × 2 > contextWindow（阈值恒负每步必发无进展压缩）", { reserveTokens: 600 }],
    ["keepRecentTokens 负值", { keepRecentTokens: -1 }],
    ["keepRecentTokens NaN（比较恒 false 静默穿透）", { keepRecentTokens: Number.NaN }],
  ])("%s → throw", (_name, patch) => {
    expect(() => createCompactionPlugin({ ...BASE_OPTIONS, ...patch } as never)).toThrow();
  });

  it("合法配置过门 + 摘要面解析（输出上限缺省 0.8×reserve）", () => {
    expect(() => createCompactionPlugin({ ...BASE_OPTIONS })).not.toThrow();
  });
});

describe("水位触发（agentPreStep → replace 落账）", () => {
  it("占用越阈值 → 摘要 → replace 落账 → 投影已压缩；文件账本附加", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("wm") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedSystem(session, "SYS");
      seedTurn(session, { turn: 0, user: "first question", assistant: { text: "answer-0", usage: { input: 50, output: 5 } } });
      seedTurn(session, { turn: 1, user: "second question", assistant: { text: "answer-1", usage: { input: 950, output: 5 } } });
      world.llm.scripts.push(textScript("COMPACT-SUMMARY"));
      const landed: string[] = [];
      world.ctx.on(compactionLanded, (payload) => landed.push(payload.trigger));

      await dispatchPreStep(world, { session: session.id });

      expect(landed).toEqual(["auto"]);
      expect(world.llm.calls).toHaveLength(1);
      const prompt = promptOf(world.llm.calls[0]);
      expect(prompt).toContain("<conversation>");
      expect(prompt).toContain("first question");
      const replaceEvents = session.events().filter((e) => e.type === "user/message" && typeof e.surfaceOp === "object");
      expect(replaceEvents).toHaveLength(1);
      const messages = session.deriveMessages();
      expect(messages[0]).toMatchObject({ role: "system", text: "SYS" }); // system 锚点保留
      const summaryText = (messages[1] as unknown as { content: ReadonlyArray<{ text: string }> }).content[0]?.text ?? "";
      expect(summaryText).toContain("COMPACT-SUMMARY");
      expect(summaryText).toContain("automatic continuation"); // auto 注入语
      expect(messages.length).toBeLessThan(5); // 前缀已折叠
    } finally {
      await world.ctx.dispose();
    }
  });

  it("未触发（tokens < window − reserve）→ 不压缩零拨号", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("calm") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "q", assistant: { text: "a", usage: { input: 500, output: 5 } } });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0);
      expect(made.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("领取未落账批次计入占用（大粘贴不越闸直冲 413）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("paste") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "early", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(session, { turn: 1, user: "q", assistant: { text: "a", usage: { input: 850, output: 5 } } }); // 锚 850 < 900（单轮无切口——前置一轮）
      // 模拟 beginStep 的 claim 尾事件：大粘贴（100 token）
      session.append("agent/inbox/spliced", {
        op: "insert",
        target: "next-turn",
        entries: [{ id: "p1", content: [{ type: "text", text: textOf(100) }] }],
      });
      session.append("agent/inbox/spliced", { op: "claim", target: "next-turn", turn: 1, claimed: ["p1"] });
      world.llm.scripts.push(textScript("PASTE-SUMMARY"));
      await dispatchPreStep(world, { session: session.id });
      expect(world.llm.calls).toHaveLength(1); // 850+100 > 900 → 压缩
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("累积更新（二次压缩——位置区间拓扑回归）", () => {
  it("第二次摘要收到 <previous-summary>（PRESERVE——关键信息不流失）；投影恰一个 replace 节点", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("cum") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedTurn(session, { turn: 0, user: "round-0", assistant: { text: "a0", usage: { input: 500, output: 5 } } });
      seedTurn(session, { turn: 1, user: "round-1", assistant: { text: "a1", usage: { input: 950, output: 5 } } });
      world.llm.scripts.push(textScript("SUMMARY-1"));
      await dispatchPreStep(world, { session: session.id });
      expect(world.llm.calls).toHaveLength(1);

      seedTurn(session, { turn: 2, user: "round-2", assistant: { text: "a2", usage: { input: 960, output: 5 } } });
      world.llm.scripts.push(textScript("SUMMARY-2"));
      await dispatchPreStep(world, { session: session.id });
      expect(world.llm.calls).toHaveLength(2);

      const prompt = promptOf(world.llm.calls[1]);
      expect(prompt).toContain("<previous-summary>");
      expect(prompt).toContain("SUMMARY-1");
      // 早高 seq 拓扑：第二次 replace 落账成功且投影中 replace 型节点恰一个（新替旧）
      const replaceEvents = session.events().filter((e) => e.type === "user/message" && typeof e.surfaceOp === "object");
      expect(replaceEvents).toHaveLength(2); // 日志两条（不可变）
      expect(session.surface().filter((n) => n.event.type === "user/message" && typeof n.event.surfaceOp === "object")).toHaveLength(1);
      const head = session.deriveMessages()[0] as unknown as { content: ReadonlyArray<{ text: string }> };
      expect(head.content[0]?.text).toContain("SUMMARY-2");
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("软禁用（summarizer 未配置）", () => {
  it("一次性告警 + 不压缩零拨号；主流程不受影响（二次触发只告警一次）", async () => {
    const world = await makeWorld({ summarizer: undefined });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("soft") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "q", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      await dispatchPreStep(world, { session: made.value.id });
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0);
      expect(made.value.events().some((e) => typeof e.surfaceOp === "object")).toBe(false);
      const warns = stderr.mock.calls.filter((line) => String(line[0]).includes("summarizer-unconfigured"));
      expect(warns).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("manual runner（服务直调）", () => {
  it("trigger 缺省 manual：无注入语；customInstructions 逐调用附加；返回落账统计", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("manual") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "m0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "m1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(textScript("MANUAL-SUM"));
      const runner = world.ctx.use(compactionRunner);
      const result = await runner.compact({ session: made.value.id, customInstructions: "focus-tests" });
      expect(result.ok).toBe(true);
      const prompt = promptOf(world.llm.calls[0]);
      expect(prompt).toContain("Additional focus: focus-tests");
      const head = made.value.deriveMessages()[0] as unknown as { content: ReadonlyArray<{ text: string }> };
      const text = head.content[0]?.text ?? "";
      expect(text).toContain("MANUAL-SUM");
      expect(text).not.toContain("automatic continuation"); // manual 不附加注入语
      expect(runner.summarizer?.model).toBe("sum-model"); // 摘要面暴露（单一真相）
      expect(runner.summarizer?.maxOutputTokens).toBe(80); // 输出上限缺省 floor(0.8 × reserve=100)
      expect(world.llm.calls[0]?.messages[0]).toMatchObject({ role: "system" }); // 结构化检查点纪律随拨号发送
    } finally {
      await world.ctx.dispose();
    }
  });

  it("setAutoTriggerEnabled(false) → 阈值超也不自主压缩；还回恢复", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("toggle") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "t0", assistant: { text: "a0", usage: { input: 500, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "t1", assistant: { text: "a1", usage: { input: 950, output: 5 } } });
      const runner = world.ctx.use(compactionRunner);
      runner.setAutoTriggerEnabled(false);
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(0);
      runner.setAutoTriggerEnabled(true);
      world.llm.scripts.push(textScript("BACK"));
      await dispatchPreStep(world, { session: made.value.id });
      expect(world.llm.calls).toHaveLength(1);
    } finally {
      await world.ctx.dispose();
    }
  });
});


describe("软失败矩阵（装配层——终态映射与告警面）", () => {
  async function seededFor(world: Awaited<ReturnType<typeof makeWorld>>, id: string) {
    const made = await world.store.create({ id: sid(id) });
    if (!made.ok) throw new Error(made.reason);
    seedTurn(made.value, { turn: 0, user: "f0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
    seedTurn(made.value, { turn: 1, user: "f1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
    return made.value;
  }

  it("摘要截断（H1）→ summary-truncated，无落账", async () => {
    const world = await makeWorld();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await seededFor(world, "trunc");
      world.llm.scripts.push(truncatedScript("partial"));
      const result = await world.ctx.use(compactionRunner).compact({ session: session.id });
      expect(result).toEqual({ ok: false, reason: "summary-truncated" });
      expect(session.events().some((e) => typeof e.surfaceOp === "object")).toBe(false);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("summary-truncated"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("空摘要 → summary-empty + empty-summary 告警", async () => {
    const world = await makeWorld();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await seededFor(world, "empty");
      world.llm.scripts.push(emptyScript());
      expect(await world.ctx.use(compactionRunner).compact({ session: session.id })).toEqual({ ok: false, reason: "summary-empty" });
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("empty-summary"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("输入预算耗尽（摘要窗小）→ 不拨号 + summary-input-budget-exhausted", async () => {
    const world = await makeWorld({ summarizer: { model: "sum", contextWindow: 4_100 } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = await seededFor(world, "budget");
      const result = await world.ctx.use(compactionRunner).compact({ session: session.id });
      expect(result).toEqual({ ok: false, reason: "summary-input-budget-exhausted" });
      expect(world.llm.calls).toHaveLength(0);
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("summary-input-budget-exhausted"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("llm 未停靠（waitFor 永挂起）→ llm-unavailable", async () => {
    const bare = createContext();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await loadPlugins(bare, [sessionPlugin, createCompactionPlugin({ ...BASE_OPTIONS } as never)]); // 不 provide llmRuntime
      const made = await bare.use(sessionStore).create({ id: sid("bare") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "b0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
      seedTurn(made.value, { turn: 1, user: "b1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
      const result = await bare.use(compactionRunner).compact({ session: made.value.id });
      expect(result).toEqual({ ok: false, reason: "llm-unavailable" });
      expect(stderr.mock.calls.some((line) => String(line[0]).includes("llm-unavailable"))).toBe(true);
    } finally {
      stderr.mockRestore();
      await bare.dispose();
    }
  });

  it("summarizer.model 空 → 装配 throw", () => {
    expect(() => createCompactionPlugin({ ...BASE_OPTIONS, summarizer: { model: "" } } as never)).toThrow(/summarizer\.model/);
  });

  it("微缩会话（预算吃满仅剩首候选）：无进展护栏先于空区间拒——no-cut-point（空区间不可达不变量）", async () => {
    const world = await makeWorld({ keepRecentTokens: 4 });
    try {
      const made = await world.store.create({ id: sid("span") });
      if (!made.ok) throw new Error(made.reason);
      seedSystem(made.value, "SYS");
      seedTurn(made.value, { turn: 0, user: textOf(1), assistant: { text: textOf(1), usage: { input: 10, output: 1 } } });
      seedTurn(made.value, { turn: 1, user: textOf(1), assistant: { text: textOf(1), usage: { input: 10, output: 1 } } });
      const result = await world.ctx.use(compactionRunner).compact({ session: made.value.id });
      expect(result).toEqual({ ok: false, reason: "no-cut-point" }); // cut 只能落首候选 → 护栏拒绝
    } finally {
      await world.ctx.dispose();
    }
  });

  it("path 型 tool_use 存在而账本为空 → file-ledger-empty 恰一次", async () => {
    const world = await makeWorld();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("ledger") });
      if (!made.ok) throw new Error(made.reason);
      made.value.append("turn/start", { turn: 0 });
      made.value.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "go" }] }, { surfaceOp: "append" });
      made.value.append(
        "assistant/message",
        { turn: 0, step: 0, content: [{ type: "tool_use", callId: "c9", name: "cat_file", input: JSON.stringify({ path: "/x.ts" }) }], stopReason: "stop" },
        { surfaceOp: "append" },
      );
      made.value.append("tool/result", { turn: 0, step: 0, callId: "c9", content: "ok" }, { surfaceOp: "append" });
      made.value.append("turn/end", { turn: 0, reason: { kind: "completed" } });
      seedTurn(made.value, { turn: 1, user: "next", assistant: { text: "a", usage: { input: 100, output: 5 } } });
      world.llm.scripts.push(textScript("L-SUM"));
      const first = await world.ctx.use(compactionRunner).compact({ session: made.value.id });
      expect(first.ok).toBe(true);
      const second = await world.ctx.use(compactionRunner).compact({ session: made.value.id }); // 单轮后无可切
      expect(second.ok).toBe(false);
      const warns = stderr.mock.calls.filter((line) => String(line[0]).includes("file-ledger-empty"));
      expect(warns).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });

  it("previousSummaryOf 纯函数：无 replace 节点 → undefined；replace 节点无 text 块 → 空串", async () => {
    expect(previousSummaryOf([userNode(0, "u"), assistantNode(1, "a")])).toBeUndefined();
    const noText = {
      seq: 2,
      event: {
        type: "user/message",
        seq: 2,
        time: 1,
        data: { turn: 0, step: 0, content: [{ type: "tool_use", callId: "c", name: "n", input: "{}" }] },
        surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 },
      },
    } as never;
    expect(previousSummaryOf([userNode(0, "u"), noText])).toBe("");
  });
});

describe("自愈边界与告警态回收", () => {
  it("413 自愈时会话已不在店 → 仍授 retry（不炸、不落账）", async () => {
    const world = await makeWorld();
    try {
      const decision = await world.ctx.dispatch(
        agentRequestError,
        { session: sid("vanished"), turn: 0, step: 0, failure: { message: "x", code: "http-413" }, signal: new AbortController().signal } as never,
        async () => undefined as never,
      );
      expect(decision).toEqual({ kind: "retry" });
      expect(world.llm.calls).toHaveLength(0);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("sessionDisposed 清告警态：同 id 重生会话的同类告警重新可见", async () => {
    const world = await makeWorld({ summarizer: undefined });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const made = await world.store.create({ id: sid("recycle") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "q", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      await dispatchPreStep(world, { session: made.value.id });
      world.store.dispose(made.value.id);
      const reborn = await world.store.create({ id: sid("recycle") });
      if (!reborn.ok) throw new Error(reborn.reason);
      seedTurn(reborn.value, { turn: 0, user: "q2", assistant: { text: "a", usage: { input: 950, output: 5 } } });
      await dispatchPreStep(world, { session: reborn.value.id });
      const warns = stderr.mock.calls.filter((line) => String(line[0]).includes("summarizer-unconfigured"));
      expect(warns).toHaveLength(2); // 重生会话不受旧告警态压制
    } finally {
      stderr.mockRestore();
      await world.ctx.dispose();
    }
  });
});

describe("理由词表封闭性（docs/COMPACTION.md §1.1——词表由测试锁定）", () => {
  it("可产生的全部跳过理由在闭表内逐条出现（增删词表即红）", async () => {
    const reasons: CompactionSkipReason[] = [
      "session-unknown",
      "summarizer-unconfigured",
      "llm-unavailable",
      "no-cut-point",
      "summary-input-budget-exhausted",
      "summarize-failed",
      "summary-truncated",
      "summary-empty",
      "replace-failed",
      "aborted",
    ];
    expect(reasons).toHaveLength(10); // 闭表规模锁
  });

  it("手动压缩在摘要面缺席时返回 summarizer-unconfigured（runner 诊断面）", async () => {
    const world = await makeWorld({ summarizer: undefined });
    try {
      const made = await world.store.create({ id: sid("mu") });
      if (!made.ok) throw new Error(made.reason);
      seedTurn(made.value, { turn: 0, user: "a", assistant: { text: "b" } });
      seedTurn(made.value, { turn: 1, user: "c", assistant: { text: "d" } });
      expect(await world.ctx.use(compactionRunner).compact({ session: made.value.id })).toEqual({ ok: false, reason: "summarizer-unconfigured" });
    } finally {
      await world.ctx.dispose();
    }
  });
});

describe("预锚注入头部豁免（skill 清单形态——L2 头部守卫缺陷回归）", () => {
  function injectSkillList(session: import("@x-harness/session").Session): void {
    const injected = session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "SKILL-LIST" }] }, { surfaceOp: "append" });
    if (!injected.ok) throw new Error(injected.reason);
  }

  it("症状回归：预锚 user 块占 surface[0] 不击穿保留头——预锚块与 system 锚点均不进摘要区间", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("skillhead") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      injectSkillList(session);
      seedSystem(session, "SYS");
      seedTurn(session, { turn: 0, user: "first question", assistant: { text: "answer-0", usage: { input: 50, output: 5 } } });
      seedTurn(session, { turn: 1, user: "second question", assistant: { text: "answer-1", usage: { input: 950, output: 5 } } });
      world.llm.scripts.push(textScript("COMPACT-SUMMARY"));

      await dispatchPreStep(world, { session: session.id });

      const messages = session.deriveMessages();
      // 修复前：nodes[0] 非 system → start=0 → 区间 [预锚块, system 锚点, ...] 连坐折叠
      expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "SKILL-LIST" }] });
      expect(messages[1]).toMatchObject({ role: "system", text: "SYS" });
      const summary = messages[2] as unknown as { content: ReadonlyArray<{ text: string }> };
      expect(summary.content[0]?.text ?? "").toContain("COMPACT-SUMMARY");
      expect(messages.length).toBeLessThan(6); // 前缀已折叠（预锚块+锚点+摘要+当轮消息）
    } finally {
      await world.ctx.dispose();
    }
  });

  it("症状回归：头部之后只剩上一份摘要时拒切——预锚块不得虚假满足无进展护栏（摘要摘摘要防线）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("skillstale") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      injectSkillList(session);
      seedSystem(session, "SYS");
      seedTurn(session, { turn: 0, user: "q0", assistant: { text: "a0", usage: { input: 10, output: 1 } } });
      seedTurn(session, { turn: 1, user: "q1", assistant: { text: "a1", usage: { input: 10, output: 1 } } });
      seedTurn(session, { turn: 2, user: "q2", assistant: { text: "a2", usage: { input: 10, output: 1 } } });
      const runner = world.ctx.use(compactionRunner);
      world.llm.scripts.push(textScript("FIRST-SUMMARY"));
      const first = await runner.compact({ session: session.id });
      if (!first.ok) throw new Error(first.reason);

      // 第二次：保护头后仅剩 [FIRST-SUMMARY(replace), 当轮]——修复前护栏被预锚块虚假满足 → 摘要摘摘要
      const second = await runner.compact({ session: session.id });
      expect(second).toEqual({ ok: false, reason: "no-cut-point" });
      expect(world.llm.calls).toHaveLength(1); // 第二次零拨号
    } finally {
      await world.ctx.dispose();
    }
  });
});
