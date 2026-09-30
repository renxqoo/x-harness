import { describe, expect, it } from "vitest";
import { verdictOfTurnEnd } from "@x-harness/agent-sdk/src/executor-inprocess/run.ts";
import type { SessionEvent } from "@x-harness/session";
import { registeredProvidersOf } from "../worker/assembly.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";

function turnEnd(reason: unknown): SessionEvent {
  return { seq: 1, time: 0, type: "turn/end", data: { reason } } as never;
}

describe("host settleAfter 收敛后的 verdict 单实现", () => {
  it("aborted turn 结算 ok=false（P3-1 回归）", () => {
    const verdict = verdictOfTurnEnd(turnEnd({ kind: "aborted", cause: "client-abort" }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("client-abort");
  });

  it("error/blocked 语义保持", () => {
    expect(verdictOfTurnEnd(turnEnd({ kind: "error", message: "boom" })).reason).toBe("boom");
    expect(verdictOfTurnEnd(turnEnd({ kind: "blocked", reason: "denied" })).reason).toBe("denied");
    expect(verdictOfTurnEnd(turnEnd({ kind: "completed" })).ok).toBe(true);
  });
});

describe("dialable 真闸门（P5-2 回归）", () => {
  it("空 key provider 不进 registered 集合", () => {
    const catalog = {
      providers: [
        { provider: "has-key", protocol: "anthropic", baseUrl: "https://x", apiKey: "k", models: ["m1"], contextWindow: 1 },
        { provider: "no-key", protocol: "anthropic", baseUrl: "https://y", apiKey: "", models: ["m2"], contextWindow: 1 },
      ],
      default: { provider: "has-key", model: "m1" },
      modelMeta: {},
    } as never as WorkerCatalog;
    const registered = registeredProvidersOf(catalog);
    expect(registered.has("has-key")).toBe(true);
    expect(registered.has("no-key")).toBe(false);
  });
});
