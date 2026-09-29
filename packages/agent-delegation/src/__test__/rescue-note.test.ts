import { describe, expect, it } from "vitest";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import { delegationRescueNote } from "../rescue-note.ts";
import type { LlmChunk } from "@x-harness/llm";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, PARENT_MODEL, CHILD_MODEL, makeOptions } from "./world.ts";
import type { TruncatedToolPayload } from "@x-harness/agent-loop";

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

function noteOf(decision: unknown): string {
  expect(decision).toMatchObject({ note: expect.any(String) });
  return (decision as { readonly note: string }).note;
}

describe("delegationRescueNote（件15 批3）", () => {
  it("agent_message 命中 → note 在场且含换策略锚词（file path / cut off）", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message" }), nextNone);
    const note = noteOf(out);
    expect(note).toContain("cut off");
    expect(note).toContain("write it to a file");
    expect(note).toContain("file path");
    expect(note).toContain("Do not re-send it from memory");
  });

  it("agent_spawn 命中 → note 在场且含任务简报锚词", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_spawn" }), nextNone);
    const note = noteOf(out);
    expect(note).toContain("NOT executed");
    expect(note).toContain("write it to a file");
    expect(note).toContain("references the file path");
  });

  it("白名单外（write/bash）→ undefined 透传（让位给既有抢救面）", async () => {
    expect(await delegationRescueNote()(payloadOf({ name: "write" }), nextNone)).toBeUndefined();
    expect(await delegationRescueNote()(payloadOf({ name: "bash" }), nextNone)).toBeUndefined();
  });

  it("downstream 已有 note → 让位不覆盖（链式纪律）", async () => {
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message" }), nextNote);
    expect(noteOf(out)).toBe("upstream already rescued");
  });

  it("abort → 透传 downstream（竞态不发指引）", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await delegationRescueNote()(payloadOf({ name: "agent_message", signal: controller.signal }), nextNone);
    expect(out).toBeUndefined();
  });

  it("真截断链路：半截 tool-call-delta + finish max-tokens → 配对 result 含换策略 note（内核 pairTruncatedCalls 全链）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }));
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "sp1", name: "agent_spawn", argumentsDelta: JSON.stringify({ description: "d", prompt: "x", subagent_type: "worker" }) };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "m1", name: "agent_message", argumentsDelta: '{"to":"main","message":"aaaa' };
        yield { type: "finish", finish: { kind: "max-tokens" } };
      })(),
    ]);
    parent.agent.followup("delegate");
    await parent.agent.whenIdle();
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    const childSession = (listed.content.match(/session=([A-Za-z0-9._-]+)/) ?? ["", ""])[1] as SessionId;
    expect(childSession).not.toBe("");
    const childHandle = world.loop.get(childSession);
    expect(childHandle).toBeDefined();
    if (childHandle !== undefined) {
      await childHandle.agent.whenIdle();
      const results = childHandle.agent.session.events().filter((e) => e.type === "tool/result").map((e) => JSON.stringify(e.data));
      const hit = results.find((r) => r.includes("m1"));
      expect(hit).toBeDefined();
      expect(hit).toContain("write it to a file");
      expect(hit).toContain("cut off");
      expect(hit).toContain("truncated: not executed");
    }
    await parent.dispose();
  });

  it("装配后 waterfall 派发可见（plugin apply 挂接面——handler 注册面直发）", async () => {
    const world = await makeWorld(await makeOptions({}));
    const parent = await spawnParent(world);
    const dispatched = await world.ctx.dispatch(
      agentTruncatedTool,
      payloadOf({ session: parent.agent.session.id, name: "agent_message" }),
      async () => undefined,
    ) as { note: string } | undefined;
    expect(noteOf(dispatched)).toContain("write it to a file");
    const other = await world.ctx.dispatch(
      agentTruncatedTool,
      payloadOf({ session: parent.agent.session.id, name: "write" }),
      async () => undefined,
    ) as { note: string } | undefined;
    expect(other).toBeUndefined();
    await parent.dispose();
  });
});
