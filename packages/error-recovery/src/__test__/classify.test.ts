// 纯函数单测：四桶分类 / 族处置表 / 脱敏 / WAL 折叠（compaction 账本、全败判定）。

import { describe, expect, it } from "vitest";
import { allToolResultsErrored, classifyFailure, DEFAULT_FAMILY_ACTIONS, hasCompactionLedger, sanitizeErrorMessage } from "../index.ts";
import type { SessionEvent } from "@x-harness/session";

describe("classifyFailure（C5 四桶）", () => {
  it("transport-retryable：network 与瞬态状态码", () => {
    for (const code of ["network", "http-408", "http-429", "http-500", "http-502", "http-503", "http-504"]) {
      expect(classifyFailure(code)).toBe("transport-retryable");
    }
  });

  it("auth / context-overflow / http-4xx（其余 4xx 语义类）", () => {
    expect(classifyFailure("http-401")).toBe("auth");
    expect(classifyFailure("http-403")).toBe("auth");
    expect(classifyFailure("context-overflow")).toBe("context-overflow");
    expect(classifyFailure("http-400")).toBe("http-4xx");
    expect(classifyFailure("http-422")).toBe("http-4xx");
  });

  it("non-retryable / 缺席 code → unknown（按可恢复应对）", () => {
    expect(classifyFailure("non-retryable")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure("E_TIMEOUT")).toBe("unknown");
  });

  it("缺省族处置表：5xx/network skip、4xx/unknown respond、auth/context fail", () => {
    expect(DEFAULT_FAMILY_ACTIONS).toEqual({
      "transport-retryable": "skip",
      "http-4xx": "respond",
      auth: "fail",
      "context-overflow": "fail",
      unknown: "respond",
    });
  });
});

describe("sanitizeErrorMessage（C5 respond 面脱敏）", () => {
  it("URL 剔除为 [url]", () => {
    expect(sanitizeErrorMessage("fetch failed on https://api.example.com/v1/messages?x=1 body")).toBe("fetch failed on [url] body");
  });

  it("凭据模式剔除为 [redacted]（api_key/token/bearer 赋值形，大小写不敏感）", () => {
    expect(sanitizeErrorMessage("auth failed: api_key=sk-12345 rejected")).toBe("auth failed: [redacted] rejected");
    expect(sanitizeErrorMessage("Authorization: token=abc.def.ghi expired")).toBe("Authorization: [redacted] expired");
    expect(sanitizeErrorMessage("X-Auth: token: t_9")).toContain("[redacted]");
  });

  it("无敏感面原样透传", () => {
    expect(sanitizeErrorMessage("http-400: invalid request shape")).toBe("http-400: invalid request shape");
  });
});

describe("WAL 折叠（ledger.ts）", () => {
  const ev = (type: string, data: Record<string, unknown>, surfaceOp?: unknown): SessionEvent =>
    ({ type, data, surfaceOp, seq: 0, time: "" }) as never;

  it("compaction 账本：replace 型 user/message 在场即 true（普通 append 不算）", () => {
    expect(hasCompactionLedger([ev("user/message", {}, { op: "replace", startSeq: 1, endSeq: 2 })])).toBe(true);
    expect(hasCompactionLedger([ev("user/message", {})])).toBe(false);
    expect(hasCompactionLedger([])).toBe(false);
  });

  it("全败判定：同 turn/step 的 tool/result 全 isError → true；混成功/无记录/跨 step → false", () => {
    const at = { turn: 0, step: 1 };
    expect(allToolResultsErrored([ev("tool/result", { turn: 0, step: 1, callId: "a", isError: true }), ev("tool/result", { turn: 0, step: 1, callId: "b", isError: true })], at)).toBe(true);
    expect(allToolResultsErrored([ev("tool/result", { turn: 0, step: 1, callId: "a", isError: true }), ev("tool/result", { turn: 0, step: 1, callId: "b" })], at)).toBe(false);
    expect(allToolResultsErrored([], at)).toBe(false);
    expect(allToolResultsErrored([ev("tool/result", { turn: 0, step: 2, callId: "a", isError: true })], at)).toBe(false);
  });
});
