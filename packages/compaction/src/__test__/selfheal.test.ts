// 413 自愈（docs/COMPACTION.md §1.1；对照参照系 hardening 超限自愈语义子集：承接
// http 映射 code、自愈恰一次、servedWindow 落账、他件先裁决让位；retriesForCode 口径
// 改写为 per-session lastHealed 键——同码先被别件重试不烧自愈机会的加严）。

import { describe, expect, it } from "vitest";
import { agentRequestError } from "@x-harness/agent-loop";
import { compactionLanded, compactionRunner, compactionServedWindow } from "../tokens.ts";
import { makeWorld, seedTurn, sid, textScript } from "./helpers.ts";

import type { RequestErrorDecision } from "@x-harness/agent-loop";

type Decision = Extract<RequestErrorDecision, { kind: "retry" }> | undefined;

async function dispatchError(
  world: Awaited<ReturnType<typeof makeWorld>>,
  fields: { readonly session: ReturnType<typeof sid>; readonly failure: { message: string; code?: string }; readonly turn?: number; readonly step?: number },
): Promise<Decision> {
  const decision = await world.ctx.dispatch(
    agentRequestError,
    { session: fields.session, turn: fields.turn ?? 3, step: fields.step ?? 1, failure: fields.failure, signal: new AbortController().signal } as never,
    async () => undefined as never,
  );
  return decision?.kind === "retry" ? decision : undefined; // 自愈件只观察本件应答（respond/fail 属他件决策面）
}

async function seeded(world: Awaited<ReturnType<typeof makeWorld>>, id: string) {
  const made = await world.store.create({ id: sid(id) });
  if (!made.ok) throw new Error(made.reason);
  seedTurn(made.value, { turn: 0, user: "t0", assistant: { text: "a0", usage: { input: 100, output: 5 } } });
  seedTurn(made.value, { turn: 1, user: "t1", assistant: { text: "a1", usage: { input: 100, output: 5 } } });
  seedTurn(made.value, { turn: 2, user: "t2", assistant: { text: "a2", usage: { input: 100, output: 5 } } });
  return made.value;
}

describe("http-413 紧急自愈", () => {
  it("413 → servedWindow 落 request/context → keep=0 紧急压缩 → retry；恰一次", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "heal");
      const route = { provider: "p1", model: "m1" };
      session.append("request/context", route);
      world.llm.scripts.push(textScript("EMERGENCY-SUM"));
      const landed: string[] = [];
      const windows: number[] = [];
      world.ctx.on(compactionLanded, (payload) => landed.push(payload.trigger));
      world.ctx.on(compactionServedWindow, (payload) => windows.push(payload.servedWindow));

      const first = await dispatchError(world, { session: session.id, failure: { message: "too large", code: "http-413" } });
      expect(first).toEqual({ kind: "retry" });
      expect(landed).toEqual(["emergency"]);
      expect(windows).toHaveLength(1);
      const context = session.events().filter((e) => e.type === "request/context").at(-1);
      expect(context?.data.contextWindow).toBe(windows[0]);
      // keep=0：保留区仅当前在飞轮（cut 落最后真轮起点），投影被压缩
      expect(session.deriveMessages().length).toBeLessThan(session.events().filter((e) => e.type === "user/message" && e.surfaceOp === "append").length + 1);
      const head = session.deriveMessages()[0] as unknown as { content: ReadonlyArray<{ text: string }> };
      expect(head.content[0]?.text).toContain("EMERGENCY-SUM");

      // 同 (turn,step) 再次 413 → 放行（不二次自愈、不二次拨号）
      const second = await dispatchError(world, { session: session.id, failure: { message: "still too large", code: "http-413" } });
      expect(second).toBeUndefined();
      expect(world.llm.calls).toHaveLength(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("新 step 重新获得自愈机会（lastHealed 键 = turn:step）", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "heal2");
      session.append("request/context", { provider: "p", model: "m" });
      world.llm.scripts.push(textScript("S1"));
      await dispatchError(world, { session: session.id, failure: { message: "x", code: "http-413" }, turn: 3, step: 1 });
      // 首次自愈后保留区仅剩当前轮——第二次自愈机会重新获得，但无可切零拨号、仍授 retry
      const again = await dispatchError(world, { session: session.id, failure: { message: "x", code: "http-413" }, turn: 3, step: 2 });
      expect(again).toEqual({ kind: "retry" });
      expect(world.llm.calls).toHaveLength(1);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("非 413（限流等）→ 放行不动作；下游已裁决 retry → 让位不压缩", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "pass");
      const rateLimited = await dispatchError(world, { session: session.id, failure: { message: "slow down", code: "http-429" } });
      expect(rateLimited).toBeUndefined();
      expect(world.llm.calls).toHaveLength(0);

      // 下游（更晚注册的 recovery 中间件）先裁决 retry → compaction 让位
      const off = world.ctx.on(agentRequestError, (async (payload: unknown, next: (input: unknown) => Promise<Decision>) => {
        await next(payload as never);
        return { kind: "retry" } as Decision;
      }) as never);
      const deferred = await dispatchError(world, { session: session.id, failure: { message: "too large", code: "http-413" } });
      expect(deferred).toEqual({ kind: "retry" });
      expect(world.llm.calls).toHaveLength(0); // 未压缩——重试权归下游
      off();
    } finally {
      await world.ctx.dispose();
    }
  });

  it("压缩失败（摘要流错）仍 retry 恰一次——重试重读投影，再 413 放行 fatal", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "heal-fail");
      session.append("request/context", { provider: "p", model: "m" });
      world.llm.scripts.push((async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "finish", finish: { kind: "error", message: "summarizer down", code: "http-500" } };
      })());
      const first = await dispatchError(world, { session: session.id, failure: { message: "too large", code: "http-413" } });
      expect(first).toEqual({ kind: "retry" });
      expect(session.events().some((e) => typeof e.surfaceOp === "object")).toBe(false); // 未落账
      const second = await dispatchError(world, { session: session.id, failure: { message: "too large", code: "http-413" } });
      expect(second).toBeUndefined();
    } finally {
      await world.ctx.dispose();
    }
  });

  it("无线路记录（无 provider）→ 跳过 servedWindow 落账仍自愈", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "no-route");
      world.llm.scripts.push(textScript("S"));
      const decision = await dispatchError(world, { session: session.id, failure: { message: "x", code: "http-413" } });
      expect(decision).toEqual({ kind: "retry" });
      expect(session.events().some((e) => e.type === "request/context")).toBe(false);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("runner 服务不被 413 路径污染（自愈后新轮可手动压缩）", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "after");
      await dispatchError(world, { session: session.id, failure: { message: "x", code: "http-413" } });
      seedTurn(session, { turn: 3, user: "t3", assistant: { text: "a3", usage: { input: 100, output: 5 } } }); // 新轮 → 有可切
      world.llm.scripts.push(textScript("MANUAL-AFTER"));
      const result = await world.ctx.use(compactionRunner).compact({ session: session.id });
      expect(result.ok).toBe(true);
    } finally {
      await world.ctx.dispose();
    }
  });

  it("context-overflow 码同触发自愈（docs/OUTPUT-TOKEN-CONTINUATION.md：主力 provider 输入溢出为 400+文案分类码）；纯 http-400 不触发", async () => {
    const world = await makeWorld();
    try {
      const session = await seeded(world, "heal-overflow");
      session.append("request/context", { provider: "p", model: "m" });
      world.llm.scripts.push(textScript("EMERGENCY-SUM"));
      const landed: string[] = [];
      world.ctx.on(compactionLanded, (payload) => landed.push(payload.trigger));

      const healed = await dispatchError(world, { session: session.id, failure: { message: "prompt is too long", code: "context-overflow" } });
      expect(healed).toEqual({ kind: "retry" });
      expect(landed).toEqual(["emergency"]);

      // 状态码直报形态（无 overflow 文案）不属词表——放行不动作
      const plain400 = await dispatchError(world, { session: session.id, failure: { message: "bad request", code: "http-400" } });
      expect(plain400).toBeUndefined();
    } finally {
      await world.ctx.dispose();
    }
  });
});
