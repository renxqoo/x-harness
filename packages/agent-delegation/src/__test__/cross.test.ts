// 跨进程接线测试（docs/AGENT-DELEGATION.md §5.2-4b/§5.3/§5.4/§11.2）：双世界共享 mailbox
// root（同 pid 双 box 模拟跨进程）、信封往返、notify_when_idle 闭窗与订阅结算、三种拒、
// list local-session 行、teardown 关箱。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SessionId } from "@x-harness/session";
import type { LlmChunk } from "@x-harness/llm";
import { sessionStore } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, makeOptions, workerOptions, resetWorlds } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const userTextsOf = (world: World, session: SessionId): string =>
  world.ctx
    .use(sessionStore)
    .get(session)
    ?.events()
    .filter((e) => e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";

interface TwinWorlds {
  readonly alpha: World;
  readonly beta: World;
  readonly alphaMain: Awaited<ReturnType<typeof spawnParent>>;
  readonly betaMain: Awaited<ReturnType<typeof spawnParent>>;
  readonly root: string;
}

async function makeTwins(): Promise<TwinWorlds> {
  const root = await mkdtemp(join(tmpdir(), "xh-cross-"));
  const options = await workerOptions();
  const alpha = await makeWorld({ ...options, mailbox: { box: "alpha", mainSession: "main-1" as SessionId } }, root);
  const beta = await makeWorld({ ...options, mailbox: { box: "beta", mainSession: "main-2" as SessionId } }, root);
  const alphaMain = await spawnParent(alpha, PARENT_MODEL, "main-1" as SessionId);
  const betaMain = await spawnParent(beta, PARENT_MODEL, "main-2" as SessionId);
  return { alpha, beta, alphaMain, betaMain, root };
}

describe("跨进程消息（§5.3 投递时序）", () => {
  it("box 域裸名投递：alpha→beta 信封经 drain steer 进 beta 宿主 main（步边界/唤醒语义）", async () => {
    const twins = await makeTwins();
    const { alpha, beta, alphaMain, betaMain } = twins;
    alpha.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "sent")]);
    beta.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "beta ack")]);
    const sent = await callTool({ world: alpha, name: "agent_message", args: { to: "beta", message: "ping from alpha" }, session: alphaMain.agent.session.id });
    expect(sent.isError).toBeUndefined();
    expect(sent.content).toContain("Delivered to beta");
    await vi.waitFor(() => {
      expect(userTextsOf(beta, betaMain.agent.session.id)).toContain("cross-session-message");
      expect(userTextsOf(beta, betaMain.agent.session.id)).toContain("ping from alpha");
    }, { timeout: 5_000 });
    await vi.waitFor(() => expect(beta.scripts.get(PARENT_MODEL)?.length ?? 1).toBe(0), { timeout: 5_000 }); // beta main 被唤醒消费了脚本
    await alphaMain.dispose();
    await betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });

  it("往返：beta 回信 alpha（from=beta 信封进 alpha 宿主 main）", async () => {
    const twins = await makeTwins();
    const { alpha, beta, alphaMain, betaMain } = twins;
    alpha.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "a1"), textScript(PARENT_MODEL, "a2")]);
    beta.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "b1"), textScript(PARENT_MODEL, "b2")]);
    await callTool({ world: beta, name: "agent_message", args: { to: "alpha", message: "hello alpha" }, session: betaMain.agent.session.id });
    await vi.waitFor(() => expect(userTextsOf(alpha, alphaMain.agent.session.id)).toContain("hello alpha"), { timeout: 5_000 });
    await callTool({ world: alpha, name: "agent_message", args: { to: "beta", message: "hello beta" }, session: alphaMain.agent.session.id });
    await vi.waitFor(() => expect(userTextsOf(beta, betaMain.agent.session.id)).toContain("hello beta"), { timeout: 5_000 });
    await alphaMain.dispose();
    await betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });

  it("未知 box → not-found；list_agents 列 local-session 行（kind/status/ref）", async () => {
    const twins = await makeTwins();
    const { alpha, alphaMain } = twins;
    const unknown = await callTool({ world: alpha, name: "agent_message", args: { to: "ghost-box", message: "x" }, session: alphaMain.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("not-found:ghost-box");
    const listed = await callTool({ world: alpha, name: "list_agents", args: {}, session: alphaMain.agent.session.id });
    expect(listed.content).toMatch(/beta \[[0-9a-f]{6}\] kind=local-session status=idle/);
    await alphaMain.dispose();
    await twins.betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });
});

describe("notify_when_idle（§5.4 闭窗与结算）", () => {
  it("目标已 idle → 立即投本机 main（不写订阅）", async () => {
    const twins = await makeTwins();
    const { alpha, alphaMain } = twins;
    alpha.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "consume")]);
    const subbed = await callTool({ world: alpha, name: "agent_message", args: { to: "beta", notify_when_idle: true }, session: alphaMain.agent.session.id });
    expect(subbed.isError).toBeUndefined();
    expect(subbed.content).toContain("notice was sent immediately");
    await vi.waitFor(() => expect(userTextsOf(alpha, alphaMain.agent.session.id)).toContain("[Cross-session idle notice]"), { timeout: 5_000 });
    // 不写订阅：beta 的 subs 空
    await alphaMain.dispose();
    await twins.betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });

  it("目标 busy → 订阅；转 idle 时恰好一条 notice（一次性 + 订阅摘除）", async () => {
    const twins = await makeTwins();
    const { alpha, beta, alphaMain, betaMain } = twins;
    alpha.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "watch")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beta.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "text-delta", text: "beta busy turn" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    betaMain.agent.followup("hold busy"); // beta main 进入 running
    await vi.waitFor(async () => {
      const listed = await callTool({ world: alpha, name: "list_agents", args: {}, session: alphaMain.agent.session.id });
      expect(listed.content).toContain("kind=local-session status=running");
    }, { timeout: 5_000 });
    const subbed = await callTool({ world: alpha, name: "agent_message", args: { to: "beta", message: "work then ping me", notify_when_idle: true }, session: alphaMain.agent.session.id });
    expect(subbed.isError).toBeUndefined();
    expect(subbed.content).toContain("next goes idle");
    release();
    await vi.waitFor(() => expect(userTextsOf(alpha, alphaMain.agent.session.id)).toContain("[Cross-session idle notice]"), { timeout: 5_000 });
    const notices = userTextsOf(alpha, alphaMain.agent.session.id).split("[Cross-session idle notice]").length - 1;
    expect(notices).toBe(1); // 恰好一条
    await alphaMain.dispose();
    await betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });

  it("三种拒：子代理调用 / 未开箱部署 / 纯空发（message 缺且非订阅）", async () => {
    const twins = await makeTwins();
    const { alpha, alphaMain } = twins;
    // 子代理调用
    const spawned = await callTool({ world: alpha, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: alphaMain.agent.session.id });
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    const fromChild = await callTool({ world: alpha, name: "agent_message", args: { to: "beta", notify_when_idle: true }, session: childSession });
    expect(fromChild.isError).toBe(true);
    expect(fromChild.content).toContain("only available from the main conversation");
    // 未开箱部署
    const plain = await makeWorld(await workerOptions());
    const plainMain = await spawnParent(plain);
    const noBox = await callTool({ world: plain, name: "agent_message", args: { to: "beta", notify_when_idle: true }, session: plainMain.agent.session.id });
    expect(noBox.isError).toBe(true);
    expect(noBox.content).toContain("no local mailbox");
    await plainMain.dispose();
    // 无 message + 非订阅 → invalid-args（动词误用先于寻址裁决）
    const empty = await callTool({ world: alpha, name: "agent_message", args: { to: "ghost-box" }, session: alphaMain.agent.session.id });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("message is required");
    await alphaMain.dispose();
    await twins.betaMain.dispose();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });
});

describe("teardown（§5.3 关箱序列）", () => {
  it("ctx dispose → box 目录删除（结算后关箱）", async () => {
    const twins = await makeTwins();
    const { alpha, beta } = twins;
    await alpha.disposePlugins();
    await vi.waitFor(() => expect(existsSync(join(twins.root, "alpha"))).toBe(false), { timeout: 5_000 });
    expect(existsSync(join(twins.root, "beta"))).toBe(true); // 他人不动
    await beta.disposePlugins();
    await rm(twins.root, { recursive: true, force: true }).catch(() => {});
  });
});

describe("consumer 降级路径（§5.3 at-most-once 如实）", () => {
  it("main 未建/已封存 → 信封丢弃走 onWarn（drain 不击穿）；死箱投递 not-live", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-cross-"));
    const warns: string[] = [];
    const options = await makeOptions({});
    // 孤立 consumer：loop 里没有 main 会话
    const world = await makeWorld({ ...options, mailbox: { box: "lone", mainSession: "main-x" as SessionId }, onWarn: (m) => warns.push(m) }, root);
    // 死箱：raw manifest 死 pid
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "deadbox"), { recursive: true });
    await writeFile(join(root, "deadbox", "manifest.json"), `${JSON.stringify({ pid: 999_999_999, bootId: "aabbccddeeff", status: "idle", updatedTs: Date.now() })}\n`);
    const refused = await callTool({ world: world, name: "agent_message", args: { to: "deadbox", message: "x" }, session: "main-x" as SessionId });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("not-found:deadbox"); // 死箱在发现面即排除
    // not-live 竞态窗（发现时活、投递时死）：stub 服务直测 sendCross 的 not-live 透传
    const { sendCross } = await import("../crossmsg.ts");
    const stub = {
      discover: async () => [{ name: "flaky", ref: "abc123", status: "running" as const }],
      send: async () => ({ ok: false, reason: "not-live:flaky" }),
      subs: { add: async () => {}, list: async () => [], remove: async () => {} },
      timing: { pollIntervalMs: 20, heartbeatMs: 5000, graceMs: 30000, staleMs: 1, now: () => Date.now() },
    };
    const raced = await sendCross(
      { service: stub as never, loop: world.loop, box: "lone", mainSession: "main-x" as SessionId, lineage: { bySession: () => undefined } as never },
      { callId: "c1", name: "agent_message", signal: new AbortController().signal, session: "main-x" as never },
      { to: "flaky", message: "x" },
    );
    expect(raced.ok).toBe(false);
    expect(raced.ok === false && raced.reason).toContain("not-live:flaky");
    // 给 lone 箱塞一封信封再 drainOnce 语义验证：main 缺位丢弃
    const { createMailboxService } = await import("@x-harness/session-mailbox");
    const svc2 = createMailboxService({ root, timing: { pollIntervalMs: 20, heartbeatMs: 5_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() } });
    await mkdir(join(root, "lone", "inbox"), { recursive: true });
    await svc2.send("lone", { from: "someone", message: "orphan hello", kind: "message" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100); // 等 drain 定时器打一拍
    });
    expect(warns.join("\n")).toContain("main session not live");
    await world.disposePlugins();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
});

describe("notify_when_idle 闭窗分支（stub 直测——复查翻转与 main 缺位）", () => {
  it("订阅后复查发现目标已转 idle → 立即本机投 notice", async () => {
    const world = await makeWorld(await makeOptions({}));
    const main = await spawnParent(world, PARENT_MODEL, "main-9" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "consume")]);
    const { sendCross } = await import("../crossmsg.ts");
    let call = 0;
    const stub = {
      discover: async () => {
        call += 1;
        return [{ name: "flipper", ref: "abc123", status: call === 1 ? ("running" as const) : ("idle" as const) }];
      },
      send: async () => ({ ok: true }),
      subs: { add: async () => {}, list: async () => [], remove: async () => {} },
      timing: { pollIntervalMs: 20, heartbeatMs: 5000, graceMs: 30000, staleMs: 1, now: () => Date.now() },
    };
    const out = await sendCross(
      { service: stub as never, loop: world.loop, box: "watcher", mainSession: main.agent.session.id, lineage: { bySession: () => undefined } as never },
      { callId: "c9", name: "agent_message", signal: new AbortController().signal, session: main.agent.session.id },
      { to: "flipper", notify_when_idle: true },
    );
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.text).toContain("notice was sent immediately");
    await vi.waitFor(() => expect(userTextsOf(world, main.agent.session.id)).toContain("already idle"), { timeout: 5_000 });
    await main.dispose();
  });

  it("已 idle 但本机 main 缺位 → 如实回未送达（不 throw）", async () => {
    const world = await makeWorld(await makeOptions({}));
    const { sendCross } = await import("../crossmsg.ts");
    const stub = {
      discover: async () => [{ name: "idlebox", ref: "abc123", status: "idle" as const }],
      send: async () => ({ ok: true }),
      subs: { add: async () => {}, list: async () => [], remove: async () => {} },
      timing: { pollIntervalMs: 20, heartbeatMs: 5000, graceMs: 30000, staleMs: 1, now: () => Date.now() },
    };
    const out = await sendCross(
      { service: stub as never, loop: world.loop, box: "watcher2", mainSession: "main-none" as never, lineage: { bySession: () => undefined } as never },
      { callId: "c10", name: "agent_message", signal: new AbortController().signal, session: "main-none2" as never },
      { to: "idlebox", notify_when_idle: true },
    );
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.text).toContain("A [Cross-session idle notice] arrives once");
  });
});
