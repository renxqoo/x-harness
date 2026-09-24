// 件15 批3：rescue-note 用例组（docs/DELEGATION-LONG-CONTENT.md §3）——命中/让位/abort/
// 白名单外 + 装配后 waterfall 注册面（plugin apply 挂接可见）。

import { describe, expect, it } from "vitest";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import { delegationRescueNote } from "../rescue-note.ts";
import { makeWorld, spawnParent, callTool, PARENT_MODEL, makeOptions } from "./world.ts";
import type { TruncatedToolPayload } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";

const payloadOf = (over: Partial<TruncatedToolPayload> = {}): TruncatedToolPayload => ({
  session: "s" as SessionId,
  turn: 1,
  step: 1,
  callId: "c1",
  name: "agent_message",
  arguments: '{"to":"main","message":"half',
  signal: new AbortController().signal,
  ...over,
});

const nextNone = async (): Promise<undefined> => undefined;
const nextNote = async (): Promise<{ readonly note: string }> => ({ note: "upstream already rescued" });

describe("delegationRescueNote（件15 批3）", () => {
  it("agent_message 命中 → note 在场且含换策略锚词（file path / cut off）", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message" }), nextNone);
    expect(out?.note).toContain("cut off");
    expect(out?.note).toContain("write it to a file");
    expect(out?.note).toContain("file path");
    expect(out?.note).toContain("Do not re-send it from memory");
  });

  it("agent_spawn 命中 → note 在场且含任务简报锚词", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_spawn" }), nextNone);
    expect(out?.note).toContain("NOT executed");
    expect(out?.note).toContain("write it to a file");
    expect(out?.note).toContain("references the file path");
  });

  it("白名单外（write/bash）→ undefined 透传（让位给既有抢救面）", async () => {
    expect(await delegationRescueNote()(payloadOf({ name: "write" }), nextNone)).toBeUndefined();
    expect(await delegationRescueNote()(payloadOf({ name: "bash" }), nextNone)).toBeUndefined();
  });

  it("downstream 已有 note → 让位不覆盖（链式纪律）", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message" }), nextNote);
    expect(out?.note).toBe("upstream already rescued");
  });

  it("abort → 透传 downstream（竞态不发指引）", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message", signal: controller.signal }), nextNone);
    expect(out).toBeUndefined();
  });

  it("装配后 waterfall 派发可见（plugin apply 挂接面——dispatch 真 tool_use 截断经内核配对）", async () => {
    const world = await makeWorld(await makeOptions({}));
    const parent = await spawnParent(world);
    // 直接经 ctx waterfall 派发：装配世界内 agent_message 截断 payload 有 delegation note
    const dispatched = await world.ctx.dispatch(
      agentTruncatedTool,
      payloadOf({ session: parent.agent.session.id, name: "agent_message" }),
      async () => undefined,
    ) as { note: string } | undefined;
    expect(dispatched?.note).toContain("write it to a file");
    // 白名单外仍 undefined（世界内无 write 抢救件装配）
    const other = await world.ctx.dispatch(
      agentTruncatedTool,
      payloadOf({ session: parent.agent.session.id, name: "write" }),
      async () => undefined,
    ) as { note: string } | undefined;
    expect(other).toBeUndefined();
    void callTool; void PARENT_MODEL;
    await parent.dispose();
  });
});
