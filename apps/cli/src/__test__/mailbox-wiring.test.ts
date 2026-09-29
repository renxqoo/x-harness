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

    workflowDir: join(root, "workflows"),
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
    const boxes = await service!.discover();
    const mine = boxes.find((box) => box.name === `xh-${String(mainSessionId)}`);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("idle");
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
    const made = await world.loop.create({ session: { id: mainSessionId }, agent: { model: "m1", provider: "glm" } });
    if (!made.ok) throw new Error(made.reason);
    const peer = await service!.open("xh-peer-sender");
    const sent = await service!.send(`xh-${String(mainSessionId)}`, { from: peer.name, message: "ping from peer", kind: "message" });
    expect(sent.ok).toBe(true);
    const envelopes = await service!.drain(`xh-${String(mainSessionId)}`);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.message).toBe("ping from peer");
    await made.value.dispose();
    await peer.close();
    await world.ctx.dispose();
    await rm(mailboxRoot, { recursive: true, force: true });
  });
});
