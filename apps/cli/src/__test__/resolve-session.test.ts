// 会话解析（docs/CLI.md §2.6 表驱动）：主会话过滤+倒序、前缀三态、continue 候选、
// planSession 优先序矩阵。

import { describe, expect, it } from "vitest";
import type { SessionHeader, SessionId } from "@x-harness/session";
import { continueCandidate, mainSessions, matchPrefix, planSession, planToResult } from "../resolve-session.ts";

function header(over: Partial<Omit<SessionHeader, "id">> & { id: string }): SessionHeader {
  return { createdAt: 1000, cwd: "/w", ...over } as SessionHeader;
}

const HEADERS: readonly SessionHeader[] = [
  header({ id: "aaa-newest", createdAt: 3000 }),
  header({ id: "bbb-sub", createdAt: 2500, agentId: "agent-1", agentType: "worker" }),
  header({ id: "aab-mid", createdAt: 2000 }),
  header({ id: "aac-old", createdAt: 1500 }),
  header({ id: "zzz-other-cwd", createdAt: 4000, cwd: "/elsewhere" }),
];

describe("mainSessions", () => {
  it("过滤子代理会话（agentId 在场）并按 createdAt 倒序", () => {
    expect(mainSessions(HEADERS).map((h) => h.id)).toEqual(["zzz-other-cwd", "aaa-newest", "aab-mid", "aac-old"]);
  });
});

describe("matchPrefix", () => {
  it("唯一命中 / 零命中 / 多命中三态", () => {
    expect(matchPrefix(HEADERS, "aaa-n")).toEqual({ status: "unique", id: "aaa-newest" as SessionId });
    expect(matchPrefix(HEADERS, "aa")).toMatchObject({ status: "ambiguous", candidates: ["aaa-newest", "aab-mid", "aac-old"] });
    expect(matchPrefix(HEADERS, "nope")).toEqual({ status: "none" });
  });

  it("子代理会话不参与前缀匹配", () => {
    expect(matchPrefix(HEADERS, "bbb")).toEqual({ status: "none" });
  });
});

describe("continueCandidate", () => {
  it("当前 cwd 最新主会话；无候选 → undefined", () => {
    expect(continueCandidate(HEADERS, "/w")).toBe("aaa-newest");
    expect(continueCandidate(HEADERS, "/elsewhere")).toBe("zzz-other-cwd");
    expect(continueCandidate(HEADERS, "/nowhere")).toBeUndefined();
  });
});

describe("planSession（优先序矩阵）", () => {
  const none = { session: undefined, continueRecent: false, resume: false };

  it("无 flag → new", () => {
    expect(planSession(none, HEADERS, "/w")).toEqual({ kind: "new" });
  });

  it("--session：unique → resume；none/ambiguous → fail 带指引", () => {
    expect(planSession({ ...none, session: "aaa-n" }, HEADERS, "/w")).toEqual({ kind: "resume", id: "aaa-newest" as SessionId });
    const miss = planSession({ ...none, session: "nope" }, HEADERS, "/w");
    expect(miss.kind).toBe("fail");
    const ambiguous = planSession({ ...none, session: "aa" }, HEADERS, "/w");
    expect(ambiguous).toMatchObject({ kind: "fail" });
    if (ambiguous.kind === "fail") expect(ambiguous.reason).toContain("ambiguous");
  });

  it("--continue：命中 → resume；本 cwd 无候选 → new（首次使用常态）", () => {
    expect(planSession({ ...none, continueRecent: true }, HEADERS, "/w")).toEqual({ kind: "resume", id: "aaa-newest" as SessionId });
    expect(planSession({ ...none, continueRecent: true }, HEADERS, "/fresh")).toEqual({ kind: "new" });
  });

  it("--resume：有档案 → pick（倒序主会话）；无档案 → fail", () => {
    expect(planSession({ ...none, resume: true }, HEADERS, "/w")).toMatchObject({ kind: "pick" });
    expect(planSession({ ...none, resume: true }, [], "/w")).toMatchObject({ kind: "fail" });
  });

  it("planToResult：pick → fail 语义（非交互不可达）", () => {
    const picked = planSession({ ...none, resume: true }, HEADERS, "/w");
    const settled = planToResult(picked);
    expect(settled.ok).toBe(false);
  });
});
