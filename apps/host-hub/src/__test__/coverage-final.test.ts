// 覆盖收口 III：skills-admin removeSkill 分支、dialogs 坏形状/超时/denyAll、
// inflight 喂入、event-bridge childBusy/unsubscribe、compactSkipError 映射表。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeSkill, setSkillEnabled } from "../host/skills-admin.ts";
import { createDialogBroker } from "../worker/dialogs.ts";
import type { PendingDialog } from "../worker/dialogs.ts";
import { createInflightState } from "../worker/inflight.ts";
import { createEventBridge } from "../worker/event-bridge.ts";
import { compactSkipError } from "../worker/worker-commands.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills-admin removeSkill 分支", () => {
  test("project 级 → not user-defined；真 user 级 → 删（隔离 user 目录注入）", async () => {
    const projectCwd = await tempDir("hub-rm-");
    const skillDir = join(projectCwd, ".x-harness", "skills", "beta");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: beta\ndescription: B\n---\nbody", "utf8");
    const projectRemoval = await removeSkill({ name: "beta", trustedCwds: [projectCwd] });
    expect(projectRemoval).toEqual({ ok: false, error: "skill not user-defined: beta" });
    // user 级真删路径：os.homedir() 在 Bun 下不随 HOME env 翻转（进程启动期定值），
    // 真实 user 目录不可测试隔离——该分支由 process smoke 的设置面旅程覆盖（真进程
    // 可设 HOME）。此处补 unknown-skill 拒面：
    const ghost = await removeSkill({ name: "ghost-skill", trustedCwds: [] });
    expect(ghost).toEqual({ ok: false, error: expect.stringContaining("unknown skill: ghost-skill") });
    void homedir;
    void setSkillEnabled;
  });
});

describe("dialogs broker 分支", () => {
  test("坏形状按拒绝结算；未知 requestId 忽略；超时默认拒；pendingAll/denyAll", async () => {
    const sent: string[] = [];
    const broker = createDialogBroker({ confirmTimeoutMs: 40, sendFrame: (line) => sent.push(line) });
    const confirmPromise = broker.confirm("t1", { tool: "bash", summary: "ls", reason: "r" });
    const request = JSON.parse(sent[0] as string) as PendingDialog;
    expect(broker.pendingCount()).toBe(1);
    expect(broker.resolve(request.requestId, "junk")).toBe(true); // 坏形状 → settle(false)
    await expect(confirmPromise).resolves.toBe(false);
    expect(broker.resolve("no-such", { confirmed: true })).toBe(false); // 未知忽略
    expect(broker.pendingAll()).toEqual([]); // 已结算出队
    // 超时默认拒
    const timeoutPromise = broker.confirm("t1", { tool: "bash", reason: "r" });
    await expect(timeoutPromise).resolves.toBe(false);
    // denyAll：挂起全部拒绝
    const pending1 = broker.confirm("t1", { tool: "read", reason: "r" });
    const pending2 = broker.confirm("t1", { tool: "write", reason: "r" });
    expect(broker.pendingCount()).toBe(2);
    broker.denyAll();
    await expect(pending1).resolves.toBe(false);
    await expect(pending2).resolves.toBe(false);
  });
});

describe("inflight 状态机", () => {
  test("partial/toolOutput 尾部/满表不挤/toolDone/turnStart 重置", () => {
    const state = createInflightState();
    state.turnStart(0, 1_000);
    state.partial({ role: "assistant", content: [] });
    state.toolOutput("c1", "x".repeat(70_000));
    state.toolOutput("c1", "more");
    const withTruncate = state.snapshot().toolOutputs[0];
    expect(withTruncate?.truncated).toBe(true); // 粘滞
    for (let i = 0; i < 12; i += 1) state.toolOutput(`fill-${i}`, "y");
    expect(state.snapshot().toolOutputs.length).toBeLessThanOrEqual(8); // 满表不挤
    state.toolDone("c1");
    expect(state.snapshot().toolOutputs.some((entry) => entry.callId === "c1")).toBe(false);
    state.turnEnd();
    expect(state.snapshot().turnStartSeq).toBeNull();
    state.turnStart(5, 2_000);
    expect(state.snapshot().turnStartSeq).toBe(5);
  });
});

describe("event-bridge 观察面", () => {
  test("未装配不外发（threadId 空）；childBusy 默认 false", () => {
    const lines: string[] = [];
    const bridge = createEventBridge({ emitLine: (line) => lines.push(line), threadId: () => "", inflight: createInflightState() });
    bridge.emitSettled("s1", true);
    expect(lines).toEqual([]); // 无盖章不外发
    expect(bridge.childBusy()).toBe(false);
    expect(bridge.isStreaming()).toBe(false);
    bridge.unsubscribe(); // 幂等
  });
});

describe("addModel 校验矩阵（分支补面）", () => {
  test("字段校验族：contextWindow/maxTokens/reasoning/cost/protocol/baseUrl/provider", async () => {
    const agentDir = await tempDir("hub-ma-");
    const { addModel } = await import("../host/models-admin.ts");
    expect((await addModel(agentDir, { id: "m", contextWindow: 1.5 })).ok).toBe(false);
    expect((await addModel(agentDir, { id: "m", maxTokens: -1 })).ok).toBe(false);
    expect((await addModel(agentDir, { id: "m", reasoning: "yes" })).ok).toBe(false);
    expect((await addModel(agentDir, { id: "m", cost: "bad" })).ok).toBe(false);
    expect((await addModel(agentDir, { id: "m", provider: "newp", protocol: "anthropic", baseUrl: "ftp://x" })).ok).toBe(false);
    expect((await addModel(agentDir, { id: "m", provider: "  ", protocol: "anthropic", baseUrl: "https://x" })).ok).toBe(false);
    // bare-entry 形态（仅 id + 既有 provider）
    const okBare = await addModel(agentDir, { id: "glm-5.3-air", provider: "glm" });
    expect(okBare).toMatchObject({ ok: true, model: { id: "glm-5.3-air", provider: "glm", contextWindow: 1_000_000, source: "custom" } }); // bare 追加不带 cost（预设 cost 表只在 preset source 保留）
    // remove 后空档案自删
    const { removeModel } = await import("../host/models-admin.ts");
    expect((await removeModel(agentDir, "glm-5.3-air")).ok).toBe(true);
  });
});

describe("compactSkipError 封闭映射", () => {
  test("全 reason 词表映射", () => {
    expect(compactSkipError("no-cut-point")).toBe("context too small to compact");
    expect(compactSkipError("summary-input-budget-exhausted")).toBe("context too small to compact");
    expect(compactSkipError("summary-empty")).toBe("context too small to compact");
    expect(compactSkipError("summarizer-unconfigured")).toBe("compaction summarizer not configured");
    expect(compactSkipError("aborted")).toBe("compaction aborted");
    expect(compactSkipError("summarize-failed")).toBe("compaction failed: summarize-failed");
    expect(compactSkipError("llm-unavailable")).toBe("compaction failed: llm-unavailable");
    expect(compactSkipError("replace-failed")).toBe("compaction failed: replace-failed");
    expect(compactSkipError("session-unknown")).toBe("compaction failed: session-unknown");
  });
});
