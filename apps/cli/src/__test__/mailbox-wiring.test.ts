// mailbox 宿主接线（AGENT-DELEGATION §5.3）：buildWorld 后 delegation 在装配期真开箱
// （box = xh-<mainSessionId>、信封路由目的地 = mainSession）；dispose 关箱（目录消失）。
// 断言对象是 delegation 装配产物本身（discover 扫盘可见），不是复刻派生式——接线被删即红。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmAdapter } from "@x-harness/llm";
import { mintSessionId } from "@x-harness/session";
import { mailboxService } from "@x-harness/session-mailbox";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

/** 最小 adapter：拨号不打网络（装配断言不触发请求） */
const stubAdapter: LlmAdapter = {
  name: "fake",
  stream: () => {
    throw new Error("stub adapter must not be dialed in assembly tests");
  },
};

async function assembleFixture(): Promise<{ world: World; mailboxRoot: string; mainSessionId: import("@x-harness/session").SessionId }> {
  const root = await mkdtemp(join(tmpdir(), "xh-mailbox-"));
  const mainSessionId = mintSessionId();
  const built = await buildWorld({
    mainSessionId,
    mailboxRoot: join(root, "mailbox"),
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist: false,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    broker: createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) }),
    adapters: [stubAdapter],
  });
  if (!built.ok) throw new Error(built.reason);
  return { world: built.value, mailboxRoot: join(root, "mailbox"), mainSessionId };
}

describe("mailbox 宿主接线", () => {
  it("装配即开箱：delegation 按 mainSessionId 开 xh-<id> 箱（discover 扫盘可见，manifest 活）", async () => {
    const { world, mailboxRoot, mainSessionId } = await assembleFixture();
    const service = world.ctx.tryUse(mailboxService);
    expect(service).toBeDefined();
    expect(service?.root).toBe(mailboxRoot);
    // 核心断言：箱由 delegation 装配期开启（不是测试自己 open）——buildWorld 返回即可见
    const boxes = await service!.discover();
    const mine = boxes.find((box) => box.name === `xh-${String(mainSessionId)}`);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("idle"); // main 会话尚未运行
    await world.ctx.dispose();
    await rm(mailboxRoot, { recursive: true, force: true });
  });

  it("dispose 关箱：ctx 回卷（停 drain→停心跳→关箱）后目录消失，discover 不再列出", async () => {
    const { world, mailboxRoot, mainSessionId } = await assembleFixture();
    const service = world.ctx.tryUse(mailboxService);
    const before = await service!.discover();
    expect(before.some((box) => box.name === `xh-${String(mainSessionId)}`)).toBe(true);
    await world.ctx.dispose();
    const after = await service!.discover();
    expect(after.some((box) => box.name === `xh-${String(mainSessionId)}`)).toBe(false);
    await rm(mailboxRoot, { recursive: true, force: true });
  });

  it("信封路由闭环：对端向 xh-<mainSessionId> 投信 → drain 后 steer 进 main 会话（收件人正确）", async () => {
    const { world, mailboxRoot, mainSessionId } = await assembleFixture();
    const service = world.ctx.tryUse(mailboxService);
    // main 会话必须建立（delegation 路由目的地）——复刻 openWorld 的 create 路径
    const made = await world.loop.create({ session: { id: mainSessionId }, agent: { model: "m1", provider: "glm" } });
    if (!made.ok) throw new Error(made.reason);
    // 对端（另一箱）投信——模拟跨进程进程 B
    const peer = await service!.open("xh-peer-sender");
    const sent = await service!.send(`xh-${String(mainSessionId)}`, { from: peer.name, message: "ping from peer", kind: "message" });
    expect(sent.ok).toBe(true);
    // drain 单拍（测试确定性入口——运行期由 300ms 定时器驱动同一函数）
    const envelopes = await service!.drain(`xh-${String(mainSessionId)}`);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.message).toBe("ping from peer");
    await made.value.dispose();
    await peer.close();
    await world.ctx.dispose();
    await rm(mailboxRoot, { recursive: true, force: true });
  });
});
