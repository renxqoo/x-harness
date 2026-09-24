// 覆盖收口 III：skills-admin removeSkill 分支、dialogs 坏形状/超时/denyAll、
// inflight 喂入、event-bridge childBusy/unsubscribe、compactSkipError 映射表。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@x-harness/skill";
import { listSkills, removeSkill, setSkillEnabled } from "../host/skills-admin.ts";
import { createDialogBroker } from "../worker/dialogs.ts";
import { createBashExec } from "../worker/bash-exec.ts";
import type { PendingDialog } from "../worker/dialogs.ts";
import { createInflightState } from "../worker/inflight.ts";
import { createEventBridge } from "../worker/event-bridge.ts";
import { compactSkipError } from "@x-harness/compaction";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills-admin（HOME 注入缝——user 技能根可隔离）", () => {
  test("project 级遮蔽 → not user-defined；未知名 → unknown skill", async () => {
    const projectCwd = await tempDir("hub-rm-");
    const skillDir = join(projectCwd, ".x-harness", "skills", "beta");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: beta\ndescription: B\n---\nbody", "utf8");
    // user 根（注入 HOME）为空 → beta 属 project 级：删除是 user 级专属 → 拒
    const home = await tempDir("hub-home-");
    const projectRemoval = await removeSkill({ name: "beta", trustedCwds: [projectCwd], homeDir: home });
    expect(projectRemoval).toEqual({ ok: false, error: { code: "state_conflict", message: "skill not user-defined: beta" } });
    const ghost = await removeSkill({ name: "ghost-skill", trustedCwds: [], homeDir: home });
    expect(ghost).toEqual({ ok: false, error: { code: "state_conflict", message: expect.stringContaining("unknown skill: ghost-skill") } });
  });

  test("user 级移除 = 删技能目录（回归：旧实现只删 SKILL.md，残留目录 + 捆绑文件，且每次装载告警）", async () => {
    const home = await tempDir("hub-home-");
    const root = join(home, ".x-harness", "skills");
    const skillDir = join(root, "beta");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: beta\ndescription: B\n---\nbody", "utf8");
    await writeFile(join(skillDir, "references", "guide.md"), "# guide", "utf8");
    expect(await removeSkill({ name: "beta", trustedCwds: [], homeDir: home })).toEqual({ ok: true });
    expect(await stat(skillDir).catch(() => undefined)).toBeUndefined(); // 目录整体（含捆绑文件）消失
    expect(await loadSkills([root])).toEqual({ skills: {}, warnings: [] }); // 装载零告警
  });

  test("symlink 技能移除：删链接不删目标（dotfiles/stow 摆放实体不受影响）", async () => {
    const home = await tempDir("hub-home-");
    const outside = await tempDir("hub-out-");
    const root = join(home, ".x-harness", "skills");
    await writeFile(join(outside, "SKILL.md"), "---\nname: linked\ndescription: L\n---\n", "utf8");
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "linked"));
    expect(await removeSkill({ name: "linked", trustedCwds: [], homeDir: home })).toEqual({ ok: true });
    expect(await stat(join(root, "linked")).catch(() => undefined)).toBeUndefined();
    expect((await stat(join(outside, "SKILL.md"))).isFile()).toBe(true);
  });

  test("回归：set_enabled 带 cwd 在全新项目（无 .x-harness 目录）也能落盘 + enable 后并集残留 → stillDisabled by user（DESIGN §3.9）", async () => {
    const home = await tempDir("hub-home-");
    const agentDir = await tempDir("hub-agent-");
    const projectCwd = await tempDir("hub-proj-");
    // agentDir 派生缝：agentDir 在场时 user 根 = <agentDir>/skills（homeDir 注入缝退居次位）
    const root = join(agentDir, "skills");
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n", "utf8");
    // user 名单禁用
    expect(await setSkillEnabled({ agentDir, homeDir: home, name: "alpha", enabled: false })).toEqual({ ok: true });
    // 带 cwd 再禁用 → 项目级名单落盘（自身无残留提示——by 只报 user 级残留）
    expect(await setSkillEnabled({ agentDir, homeDir: home, name: "alpha", enabled: false, cwd: projectCwd })).toEqual({ ok: true });
    // 带 cwd 启用：项目级条目删除，但 user 名单仍含 → stillDisabled by user
    expect(await setSkillEnabled({ agentDir, homeDir: home, name: "alpha", enabled: true, cwd: projectCwd })).toEqual({ ok: true, stillDisabled: "user" });
    const project = JSON.parse(await readFile(join(projectCwd, ".x-harness", "hub-settings.json"), "utf8")) as { "skills.disabled"?: string[] };
    expect(project["skills.disabled"]).toEqual([]);
  });

  test("list/set_enabled 走注入 HOME：user 层真读真写（含 project 层并集）", async () => {
    const home = await tempDir("hub-home-");
    const agentDir = await tempDir("hub-agent-");
    const root = join(agentDir, "skills");
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n", "utf8");
    const listed = await listSkills({ agentDir, homeDir: home });
    expect(listed.skills).toEqual([{ name: "alpha", source: "user", path: join(root, "alpha", "SKILL.md"), disabled: false }]);
    expect(await setSkillEnabled({ agentDir, homeDir: home, name: "alpha", enabled: false })).toEqual({ ok: true });
    expect((await listSkills({ agentDir, homeDir: home })).skills[0]?.disabled).toBe(true);
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
    await expect(confirmPromise).resolves.toMatchObject({ allowed: false });
    expect(broker.resolve("no-such", { confirmed: true })).toBe(false); // 未知忽略
    // 结构化应答（PERMISSION-V2 §6.2）：verdict+memory+rule 改写全字段面；布尔退化=once
    const structuredPromise = broker.confirm("t1", { tool: "bash", reason: "r", options: ["once", "session", "project"], suggestedRule: "Bash(x:*):allow" });
    const lastRequest = sent.map((line) => JSON.parse(line) as { requestId: string }).at(-1);
    expect(lastRequest).toBeDefined();
    if (lastRequest !== undefined) {
      expect(broker.resolve(lastRequest.requestId, { verdict: "allow", memory: "project", rule: "Bash(y:*):allow" })).toBe(true);
      await expect(structuredPromise).resolves.toMatchObject({ allowed: true, memory: "project", ruleOverride: "Bash(y:*):allow" });
    }
    // 结构化字段帧契约（agent-app 消费面）：summary/options/suggestedRule/escalate 原样进 payload
    const escalateConfirm = broker.confirm("t1", { tool: "bash", summary: "mytool run", reason: "sandbox failure", options: ["once", "session"], suggestedRule: "Bash(x:*):allow", escalate: { command: "mytool run", failureText: "Operation not permitted" } });
    const escReq = sent.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1); // 帧面平铺（uiRequestFrame 顶层字段）
    expect(escReq).toMatchObject({ summary: "mytool run", options: ["once", "session"], suggestedRule: "Bash(x:*):allow", escalate: { command: "mytool run", failureText: "Operation not permitted" } });
    const escReqId = sent.map((line) => JSON.parse(line) as { requestId: string }).at(-1);
    if (escReqId !== undefined) {
      broker.resolve(escReqId.requestId, { verdict: "deny" });
      await expect(escalateConfirm).resolves.toMatchObject({ allowed: false });
    }
    const boolOnce = broker.confirm("t1", { tool: "read", reason: "r" });
    const boolReq = sent.map((line) => JSON.parse(line) as { requestId: string }).at(-1);
    if (boolReq !== undefined) {
      broker.resolve(boolReq.requestId, { confirmed: true });
      await expect(boolOnce).resolves.toMatchObject({ allowed: true }); // 布尔退化=once（无记忆）
    }
    expect(broker.pendingAll()).toEqual([]); // 已结算出队
    // 超时默认拒
    const timeoutPromise = broker.confirm("t1", { tool: "bash", reason: "r" });
    await expect(timeoutPromise).resolves.toMatchObject({ allowed: false });
    // denyAll：挂起全部拒绝
    const pending1 = broker.confirm("t1", { tool: "read", reason: "r" });
    const pending2 = broker.confirm("t1", { tool: "write", reason: "r" });
    expect(broker.pendingCount()).toBe(2);
    broker.denyAll();
    await expect(pending1).resolves.toMatchObject({ allowed: false });
    await expect(pending2).resolves.toMatchObject({ allowed: false });
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
    const bridge = createEventBridge({ emitLine: (line) => lines.push(line), threadId: () => "", inflight: createInflightState(), pendingSends: () => 0, mainEvents: () => undefined });
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

describe("审查修复回归（收口处置）", () => {
  test("H2/cM4：bash-exec spawn 同步抛错 → {ok:false} 错误面（恰一响应不悬挂）", async () => {
    void 0;
    const agentDir = await tempDir("hub-fix-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => "/definitely/missing/cwd",
      confirm: async () => ({ allowed: true }),
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 5_000,
      onStateChange: () => {},
      shell: { ok: true, path: "/nonexistent/shell" },
    });
    const outcome = await bash.exec({ command: "echo x", id: "b1" });
    expect(outcome.ok).toBe(false); // spawn 抛错被 exec 顶层 catch——错误面应答
  });

  test("cM2：准入取消 → 弹窗即时结算（pendingCount 归零——不挂 5min）", async () => {
    const agentDir = await tempDir("hub-fix2-");
    const broker = createDialogBroker({ confirmTimeoutMs: 60_000, sendFrame: () => {} });
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: (fields, signal) => broker.confirm("t1", fields as { tool: string; reason: string }, signal),
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 5_000,
      onStateChange: () => {},
    });
    const pending = bash.exec({ command: "echo late", id: "b1" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    expect(broker.pendingCount()).toBe(1);
    bash.abortAdmissions(); // 取消——弹窗应即时结算
    const outcome = await pending;
    expect(outcome.ok === false && outcome.reason).toBe("aborted before execution started");
    expect(broker.pendingCount()).toBe(0); // 孤儿弹窗不占 pending/busy 面
  });

  test("M2：get_tree 子孙全收集（孙代在内 + 子代理滤除 + 环防御）", async () => {
    const { descendantsOf } = await import("../worker/worker-read-commands.ts");
    const headers = [
      { id: "root" },
      { id: "a", parentSession: "root" },
      { id: "b", parentSession: "root" },
      { id: "a1", parentSession: "a" },
      { id: "a2", parentSession: "a1" },
      { id: "agent-x", parentSession: "b", agentId: "agent-12345678" }, // 子代理滤除
      { id: "loop", parentSession: "loop" }, // 环防御（自环不进集）
    ];
    expect(descendantsOf("root", headers).sort()).toEqual(["a", "a1", "a2", "b"]);
    expect(descendantsOf("a", headers).sort()).toEqual(["a1", "a2"]);
    expect(descendantsOf("b", headers)).toEqual([]);
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
