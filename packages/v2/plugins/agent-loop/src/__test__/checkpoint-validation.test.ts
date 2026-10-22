import { expect, it } from "vitest";
import { readCheckpoint } from "../domain/read-checkpoint";
import { request } from "./helpers";
const call = { type: "tool-call", callId: "a", name: "echo", input: {} };
const assistant = { role: "assistant", content: [call] };
const result = { role: "tool", callId: "a", content: [{ type: "text", text: "done" }] };
const checkpoint = {
  runId: "r",
  step: 1,
  caller: { origin: { scopeId: "root" }, initiator: { id: "host", kind: "host", scopeId: "root" } },
  request,
  response: {
    provider: "test",
    model: "test",
    response: { protocol: "test" },
    reason: { kind: "tool-calls" },
    usage: { complete: false },
    blocks: 1,
    hasOutput: true,
    content: [
      {
        block: { kind: "tool-call", id: "b" },
        call: { callId: "a", name: "echo", input: { ok: true, value: {} } },
        status: "complete",
        citations: [],
        providerEvents: [],
      },
    ],
  },
  phase: "tools",
  messages: [...request.messages, assistant, result],
  results: [
    { callId: "a", outcome: "returned", output: { content: [{ type: "text", text: "done" }] } },
  ],
};
it("a tools checkpoint must contain matching complete messages and verified output receipts", () => {
  expect(readCheckpoint(checkpoint).ok).toBe(true);
  expect(
    readCheckpoint({
      ...checkpoint,
      phase: "response",
      messages: [...request.messages, assistant],
      results: undefined,
    }).ok,
  ).toBe(false);
  const { results, ...response } = checkpoint;
  expect(results).toHaveLength(1);
  expect(
    readCheckpoint({ ...response, phase: "response", messages: [...request.messages, assistant] })
      .ok,
  ).toBe(true);
});
it.each([
  { messages: [...request.messages, assistant], results: [] },
  { results: [{ callId: "different", outcome: "returned", output: "not-output" }] },
  {
    results: [
      {
        callId: "different",
        outcome: "returned",
        output: { content: [{ type: "text", text: "done" }] },
      },
    ],
  },
  {
    results: [
      { callId: "a", outcome: "returned", output: { content: [{ type: "text", text: "other" }] } },
    ],
  },
  {
    results: [
      { callId: "a", outcome: "unknown", error: { source: "tools", code: "execution-failed" } },
    ],
  },
  {
    results: [
      {
        callId: "a",
        outcome: "returned",
        output: { content: [] },
        error: { source: "tools", code: "execution-failed" },
      },
    ],
  },
  {
    results: [
      { callId: "a", outcome: "returned", output: { content: [] } },
      { callId: "a", outcome: "returned", output: { content: [] } },
    ],
  },
  { phase: "unknown" },
  { caller: null },
  { request: { ...request, signal: {} } },
  { response: { ...checkpoint.response, blocks: 3 } },
])("invalid tools checkpoints cannot reach persistence or continuation plugins %#", (change) => {
  expect(readCheckpoint({ ...checkpoint, ...change }).ok).toBe(false);
});
it("an unknown tool outcome has one explicit matching error message", () => {
  const unknown = {
    ...checkpoint,
    messages: [
      ...request.messages,
      assistant,
      {
        role: "tool",
        callId: "a",
        isError: true,
        content: [
          { type: "text", text: "Tool execution outcome is unknown. Do not retry automatically." },
        ],
      },
    ],
    results: [
      { callId: "a", outcome: "unknown", error: { source: "tools", code: "execution-failed" } },
    ],
  };
  expect(readCheckpoint(unknown).ok).toBe(true);
});
