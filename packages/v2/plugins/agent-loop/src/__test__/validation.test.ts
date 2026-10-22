import { expect, it } from "vitest";
import { createAgentLoopPlugin } from "../index";
import { readRequest } from "../domain/read-request";
import { defaultAgentLimits } from "../domain/read-limits";
import { request, world, value } from "./helpers";
it.each([
  null,
  [],
  1,
  "agent",
  { extra: true },
  { access: "unknown" },
  { limits: null },
  { limits: { unknown: 1 } },
  { limits: { maxSteps: 0 } },
  { limits: { maxSteps: 129 } },
  { limits: { maxActiveRuns: 65 } },
  { limits: { maxTools: 129 } },
  { limits: { timeoutMs: 1800001 } },
  { limits: { maxEvents: 1.5 } },
])("plugin configuration rejects invalid or unbounded input %#", (input) => {
  expect(createAgentLoopPlugin(input as never)).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
it.each([
  null,
  [],
  undefined,
  {},
  { ...request, model: 1 },
  { ...request, runId: "" },
  { ...request, onEvent: true },
  { ...request, tools: "echo" },
  { ...request, tools: ["echo", "echo"] },
  { ...request, tools: [""] },
  { ...request, tools: [1] },
  { ...request, signal: {} },
  { ...request, timeoutMs: 0 },
  { ...request, unknown: 1 },
  { ...request, messages: [] },
])("run input rejects invalid shape before admission %#", (input) => {
  expect(readRequest(input, defaultAgentLimits).ok).toBe(false);
});
it("snapshots do not invoke getters or retain mutable input and callbacks", () => {
  let reads = 0;
  const input = Object.defineProperty({ ...request }, "model", {
    get() {
      reads++;
      return "test";
    },
  });
  expect(readRequest(input, defaultAgentLimits).ok).toBe(false);
  expect(reads).toBe(0);
  const messages = [{ role: "user", content: [{ type: "text", text: "before" }] }];
  const parsed = readRequest(
    { ...request, messages, runId: "fixed", tools: [] },
    defaultAgentLimits,
  );
  expect(parsed.ok).toBe(true);
  messages[0]!.content[0]!.text = "after";

  if (parsed.ok) {
    expect(parsed.value.runId).toBe("fixed");
    expect(parsed.value.names).toEqual([]);
    expect(parsed.value.request.messages[0]!.content[0]).toEqual({ type: "text", text: "before" });
  }
});
it("input and tool-name byte limits reject before any model call", async () => {
  let models = 0;
  const f = await world({
    agent: { limits: { maxTranscriptBytes: 64 } },
    async run() {
      models++;
      return { ok: true, value: { reason: { kind: "stop" } } };
    },
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded" },
    });
    expect(models).toBe(0);
    expect(
      readRequest(
        { ...request, tools: ["x".repeat(100)] },
        { ...defaultAgentLimits, maxTranscriptBytes: 16 },
      ),
    ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
  } finally {
    value(await f.host.close());
  }
});
it("untrusted metadata is a frozen bounded sidecar for extensions and is never sent to the model", async () => {
  const { definePlugin } = await import("../../../../core/src/index");
  const { agentContext, agentCheckpoint, agentRunAccess } = await import("../index");
  let observed = 0;
  const tags = { sessionId: "conversation" };
  const plugin = definePlugin({
    name: "tags",
    requires: { agentContext, agentCheckpoint, agentRunAccess },
    setup(ctx) {
      const access = ctx.guard("agentRunAccess", (input) => {
        expect(input.metadata).toEqual(tags);
        return { ok: true, value: { kind: "allow" } };
      });

      if (!access.ok) return access;

      const context = ctx.middleware("agentContext", (input, next) => {
        expect(input.metadata).toEqual(tags);
        expect(Object.isFrozen(input.metadata)).toBe(true);
        observed++;
        return next(input);
      });

      if (!context.ok) return context;

      return ctx.middleware("agentCheckpoint", (input, next) => {
        expect(input.metadata).toEqual(tags);
        observed++;
        return next(input);
      });
    },
  });
  const f = await world({
    plugins: [plugin],
    async run(input) {
      expect(Object.hasOwn(input.request, "metadata")).toBe(false);
      return { ok: true, value: { reason: { kind: "stop" } } };
    },
  });

  try {
    expect((await f.service.run({ ...request, metadata: tags })).ok).toBe(true);
    expect(observed).toBe(2);
    expect(readRequest({ ...request, metadata: [] }, defaultAgentLimits).ok).toBe(false);
    expect(
      readRequest({ ...request, metadata: { text: "x".repeat(65536) } }, defaultAgentLimits),
    ).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
  } finally {
    value(await f.host.close());
  }
});
