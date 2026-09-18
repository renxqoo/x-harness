// e2e：件13 三旅程（docs/AGENT-DELEGATION.md §11.3）——跨进程（真子进程双宿主）、
// worktree（真 git 仓 + 工具面隔离 + 无改动清理）、复活（teardown → 新装配档案复活续卷）。

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { agentLoopPlugin } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createMailboxPlugin } from "@x-harness/session-mailbox";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import { must } from "./check.ts";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

interface Harness {
  readonly ctx: ReturnType<typeof createContext>;
  readonly scripts: Map<string, Array<AsyncGenerator<LlmChunk>>>;
  readonly unload: Promise<unknown>;
}

async function assemble(input: { readonly agentsDir: string; readonly mailboxRoot?: string; readonly box?: string; readonly persistence?: string; readonly grants?: boolean }): Promise<Harness> {
  const ctx = createContext();
  const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
  const plugins: Plugin[] = [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin];
  if (input.persistence !== undefined) plugins.splice(1, 0, createJsonlSessionPersistence({ root: input.persistence }));
  if (input.grants === true) plugins.push(grantsPlugin);
  if (input.mailboxRoot !== undefined) {
    plugins.push(createMailboxPlugin({ root: input.mailboxRoot, timing: { pollIntervalMs: 40, heartbeatMs: 1_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() } }));
  }
  await loadPlugins(ctx, [
    ...plugins,
    createAgentDelegationPlugin({
      agentsDirs: [input.agentsDir],
      ...(input.mailboxRoot !== undefined && input.box !== undefined ? { mailbox: { box: input.box, mainSession: "alpha-main" as SessionId } } : {}),
    }),
  ]);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request: LlmRequest) => scripts.get(request.model)?.shift() ?? (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "finish", finish: { kind: "error", message: `no-script:${request.model}`, code: "e2e" } };
    })(),
  });
  return { ctx, scripts, unload: Promise.resolve() };
}

/** worktree 隔离的授权面（GrantsRegistry 直供——旅程只需 setRootOverride 落账） */
const grantsPlugin: Plugin = {
  name: "e2e-grants",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
};

const textScript = (text: string): AsyncGenerator<LlmChunk> =>
  (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text-delta", text };
    yield { type: "finish", finish: { kind: "stop" } };
  })();

const userTextsOf = (harness: Harness, session: SessionId): string =>
  harness.ctx
    .use(sessionStore)
    .get(session)
    ?.events()
    .filter((e) => e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";

async function writeAgentMd(dir: string): Promise<void> {
  await (await import("node:fs/promises")).writeFile(
    join(dir, "worker.md"),
    "---\nname: worker\ndescription: e2e worker\nmodel: child-model\n---\nyou are the e2e worker",
  );
}

/** 旅程 1：跨进程双宿主——真子进程持 box "peer"，主进程持 box "alpha"，往返 + idle notice */
export async function runCrossProcessJourney(): Promise<void> {
  const mailboxRoot = await mkdtemp(join(tmpdir(), "xh-e2e-cross-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "xh-e2e-agents-"));
  await writeAgentMd(agentsDir);
  const peer = spawn("bun", [join(import.meta.dir, "cross-peer.ts"), mailboxRoot], { stdio: ["pipe", "inherit", "inherit"] });
  try {
    // 等 peer 就绪（box manifest 在场）
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(mailboxRoot, "peer", "manifest.json")) && Date.now() < deadline) await sleep(100);
    must(existsSync(join(mailboxRoot, "peer", "manifest.json")), "peer box 就绪");

    const harness = await assemble({ agentsDir, mailboxRoot, box: "alpha" });
    const loop = harness.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken);
    const made = await loop.create({ session: { id: "alpha-main" as SessionId }, agent: { model: "alpha-model", provider: "fake" } });
    if (!made.ok) throw new Error(`alpha main 创建失败：${made.reason}`);
    harness.scripts.set("alpha-model", [textScript("alpha consumed")]);

    // ① alpha → peer：peer 的 main 被唤醒回信（真子进程内执行）
    const registry = harness.ctx.use((await import("@x-harness/tools")).toolRegistry);
    const sent = await registry.dispatch({ callId: "e2e-x1", name: "agent_message", args: { to: "peer", message: "ping from alpha journey" }, signal: new AbortController().signal, session: "alpha-main" as SessionId });
    must(!sent.isError, `alpha → peer 投递（实际：${sent.content}）`);
    const replyDeadline = Date.now() + 15_000;
    while (!userTextsOf(harness, "alpha-main" as SessionId).includes("peer ack from real subprocess") && Date.now() < replyDeadline) await sleep(100);
    must(userTextsOf(harness, "alpha-main" as SessionId).includes("peer ack from real subprocess"), "peer 回信经信封到达 alpha main");

    // ② notify_when_idle：peer 空闲后恰好一条 notice
    const subbed = await registry.dispatch({ callId: "e2e-x2", name: "agent_message", args: { to: "peer", notify_when_idle: true }, signal: new AbortController().signal, session: "alpha-main" as SessionId });
    must(!subbed.isError, `idle 订阅（实际：${subbed.content}）`);
    const noticeDeadline = Date.now() + 15_000;
    while (!userTextsOf(harness, "alpha-main" as SessionId).includes("[Cross-session idle notice]") && Date.now() < noticeDeadline) await sleep(100);
    must(userTextsOf(harness, "alpha-main" as SessionId).includes("[Cross-session idle notice]"), "idle notice 到达 alpha main");
    const noticeCount = userTextsOf(harness, "alpha-main" as SessionId).split("[Cross-session idle notice]").length - 1;
    must(noticeCount === 1, `idle notice 恰好一条（实际 ${String(noticeCount)} 条）`);

    await made.value.dispose();
    await harness.ctx.dispose();
    void harness.unload;
    console.log("跨进程旅程：真子进程双宿主 往返投递 + 恰好一条 idle notice 通过");
  } finally {
    peer.stdin?.end();
    const exited = await Promise.race([
      new Promise<number>((resolve) => {
        peer.on("exit", (code) => resolve(code ?? 0));
      }),
      sleep(5_000).then(() => -1),
    ]);
    if (exited === -1) peer.kill("SIGKILL"); // 孤儿兜底
    await rm(mailboxRoot, { recursive: true, force: true }).catch(() => {});
    await rm(agentsDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旅程 2：worktree——真 git 仓，子写落 worktree、主仓不可达、stop 无改动自动清理 */
export async function runWorktreeJourney(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "xh-e2e-wt-"));
  const physical = realpathSync(repo);
  const prevCwd = process.cwd();
  try {
    process.chdir(repo);
    await exec("git", ["init"]);
    await exec("git", ["config", "user.email", "e2e@t"]);
    await exec("git", ["config", "user.name", "e2e"]);
    writeFileSync(join(repo, "SEED.md"), "seed\n");
    await exec("git", ["add", "."]);
    await exec("git", ["commit", "-m", "seed"]);

    const agentsDir = await mkdtemp(join(tmpdir(), "xh-e2e-wt-agents-"));
    await writeAgentMd(agentsDir);
    const harness = await assemble({ agentsDir, grants: true });
    const loop = harness.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken);
    const made = await loop.create({ agent: { model: "parent-model", provider: "fake" } });
    if (!made.ok) throw new Error(`parent 创建失败：${made.reason}`);
    harness.scripts.set("parent-model", [textScript("parent idle")]);
    const registry = harness.ctx.use((await import("@x-harness/tools")).toolRegistry);
    const spawned = await registry.dispatch({ callId: "e2e-w1", name: "agent_spawn", args: { description: "isolated build", prompt: "work in isolation", subagent_type: "worker", name: "builder", isolation: "worktree" }, signal: new AbortController().signal, session: made.value.agent.session.id });
    must(!spawned.isError, `worktree spawn（实际：${spawned.content}）`);
    const agentId = (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] as string;
    const wtParent = join(dirname(physical), ".x-harness-worktrees");
    const entry = (await (await import("node:fs/promises")).readdir(wtParent)).find((f) => f.includes(agentId));
    must(entry !== undefined, "worktree 建在 repo 外同级");
    const wtPath = join(wtParent, entry ?? "");
    must(existsSync(join(wtPath, "SEED.md")), "worktree 检出 HEAD");
    // 主仓 status 干净（worktree 不污染主仓）
    const status = await exec("git", ["-C", repo, "status", "--porcelain"]);
    must(status.stdout.trim() === "", "主仓工作树不受污染");
    // 无改动 stop → worktree 与分支清理
    const stopped = await registry.dispatch({ callId: "e2e-w2", name: "agent_stop", args: { task_id: agentId }, signal: new AbortController().signal, session: made.value.agent.session.id });
    must(!stopped.isError, `stop（实际：${stopped.content}）`);
    await sleep(100);
    must(!existsSync(wtPath), "无改动 worktree 自动清理");
    const branches = await exec("git", ["branch", "--list", `x-harness/${agentId}`]);
    must(branches.stdout.trim() === "", "临时分支删除");
    await made.value.dispose();
    await harness.ctx.dispose();
    void harness.unload;
    await rm(agentsDir, { recursive: true, force: true }).catch(() => {});
    console.log("worktree 旅程：repo 外建树 + 主仓不污染 + 无改动自动清理 通过");
  } finally {
    process.chdir(prevCwd);
    await rm(join(dirname(physical), ".x-harness-worktrees"), { recursive: true, force: true }).catch(() => {});
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旅程 3：复活——teardown 全灭 → 新装配档案 resume 父 → 按名复活子续卷双落盘 */
export async function runReviveJourney(): Promise<void> {
  const persistenceRoot = await mkdtemp(join(tmpdir(), "xh-e2e-revive-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "xh-e2e-revive-agents-"));
  await writeAgentMd(agentsDir);
  try {
    const first = await assemble({ agentsDir, persistence: persistenceRoot });
    const loop1 = first.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken);
    const parentMade = await loop1.create({ session: { id: "revive-parent" as SessionId }, agent: { model: "parent-model", provider: "fake" } });
    if (!parentMade.ok) throw new Error(`revive parent 创建失败：${parentMade.reason}`);
    const parent = parentMade.value;
    first.scripts.set("child-model", [textScript("first life"), textScript("second life")]);
    first.scripts.set("parent-model", [textScript("p1"), textScript("p2")]);
    const registry1 = first.ctx.use((await import("@x-harness/tools")).toolRegistry);
    const spawned = await registry1.dispatch({ callId: "e2e-r1", name: "agent_spawn", args: { description: "revive me", prompt: "work", subagent_type: "worker", name: "phoenix" }, signal: new AbortController().signal, session: "revive-parent" as SessionId });
    must(!spawned.isError, `spawn 命名子（实际：${spawned.content}）`);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    await sleep(300); // 子完成 + 通知
    const store1 = first.ctx.use(sessionStore);
    await store1.flush(childSession);
    await store1.flush("revive-parent" as SessionId);
    await parent.dispose();
    await first.ctx.dispose(); // 全灭（进程消失模拟）
    void first.unload;

    const second = await assemble({ agentsDir, persistence: persistenceRoot });
    const loop2 = second.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken);
    const resumedParent = await loop2.resume({ id: "revive-parent" as SessionId, agent: { model: "parent-model", provider: "fake" } });
    if (!resumedParent.ok) throw new Error(`父档案 resume 失败：${resumedParent.reason}`);
    const parentHandle = resumedParent.value;
    second.scripts.set("child-model", [textScript("second life")]);
    second.scripts.set("parent-model", [textScript("p3")]);
    const registry2 = second.ctx.use((await import("@x-harness/tools")).toolRegistry);
    const woke = await registry2.dispatch({ callId: "e2e-r2", name: "agent_message", args: { to: "phoenix", message: "rise again" }, signal: new AbortController().signal, session: "revive-parent" as SessionId });
    must(!woke.isError, `按名复活（实际：${woke.content}）`);
    // 完成屏障：等复活子真正 idle（steer 的 kick 异步——flush 快照不等 turn，审查 B-P2-9）
    const childHandle = loop2.get(childSession);
    must(childHandle !== undefined, "复活子句柄在场");
    if (childHandle !== undefined) await childHandle.agent.whenIdle();
    await second.ctx.use(sessionStore).flush(childSession);
    const { readFile } = await import("node:fs/promises");
    const childDisk = await readFile(join(persistenceRoot, childSession, "events.jsonl"), "utf8");
    must(childDisk.includes("first life") && childDisk.includes("second life"), "子会话同卷续写（两世同卷）");
    const childHeader = await readFile(join(persistenceRoot, childSession, "header.json"), "utf8");
    must(childHeader.includes('"agentName":"phoenix"'), "子 header 名字锚落盘");
    await parentHandle.dispose();
    await second.ctx.dispose();
    void second.unload;
    console.log("复活旅程：全灭 → 档案 resume 父 → 按名复活子续卷双落盘 通过");
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(agentsDir, { recursive: true, force: true }).catch(() => {});
  }
}
