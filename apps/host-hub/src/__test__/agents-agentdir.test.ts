// agents 类型目录 agentDir 派生回归（真进程）：HUB_AGENT_DIR 注入（agent-app 打包
// 态形态）时用户 agents 根 = <agentDir>/agents——agents/create 落位、agents/list
// 可见与 worker 装配装载（类型快照注入）同区。缺省（CLI 独立）保持
// ~/.x-harness/agents，由 loader 单测背书。
import { afterAll, describe, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hostsClosed: HostHandle[] = [];
afterAll(async () => {
  for (const host of hostsClosed) host.end();
  await Promise.all(hostsClosed.map((host) => host.exited().catch(() => -1)));
});

describe("agents 类型目录 agentDir 派生（真进程）", () => {
  test("agents/create 落 <agentDir>/agents；agents/list 可见；worker 装配类型快照装载", async () => {
    const host = await startHost({ script: [{ reply: "agent-probe" }] });
    hostsClosed.push(host);

    // 创建 → 目标应在 <agentDir>/agents（而非 ~/.x-harness/agents）
    host.send({ type: "agents/create", id: "ac1", name: "dirived-agent", description: "agentDir 派生回归类型", systemPrompt: "be helpful" });
    const created = await host.response("ac1");
    expect(created.success).toBe(true);
    const typePath = (created.data as { path: string }).path;
    expect(typePath).toBe(join(host.agentDir, "agents", "dirived-agent.md"));
    expect(typePath.includes(".x-harness")).toBe(false);

    // 清单可见（user 源）
    host.send({ type: "agents/list", id: "al1" });
    const listed = await host.response("al1");
    expect(listed.success).toBe(true);
    const rows = (listed.data as { agents: Array<{ name: string; source: string }> }).agents;
    expect(rows.find((row) => row.name === "dirived-agent")?.source).toBe("user");

    // 装配装载：起会话后 kick 边沿注入的类型快照含该类型（worker 用户根同 <agentDir>/agents）
    host.send({ type: "thread/start", id: "ts1", cwd: host.agentDir });
    const started = await host.response("ts1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "prompt", id: "p1", threadId, message: "probe" });
    await host.response("p1");
    await host.event("settled", (payload) => (payload as { sendId?: string }).sendId === "p1");
    host.send({ type: "get_entries", id: "ge1", threadId });
    const entries = await host.response("ge1");
    const text = JSON.stringify(entries.data);
    expect(text).toContain("dirived-agent");

    // 落盘副本可读（frontmatter 随行）
    const copy = await readFile(join(host.agentDir, "agents", "dirived-agent.md"), "utf8");
    expect(copy).toContain("agentDir 派生回归类型");
  }, 30_000);

  test("agents/remove 删 agentDir 派生根内的档", async () => {
    const host = await startHost({ script: [{ reply: "agent-probe" }] });
    hostsClosed.push(host);
    host.send({ type: "agents/create", id: "ac1", name: "temp-agent", description: "to be removed", systemPrompt: "x" });
    await host.response("ac1");
    host.send({ type: "agents/remove", id: "ar1", name: "temp-agent" });
    const removed = await host.response("ar1");
    expect(removed.success).toBe(true);
    expect(await readFile(join(host.agentDir, "agents", "temp-agent.md"), "utf8").catch(() => "")).toBe("");
    await rm(join(host.agentDir, "agents"), { recursive: true, force: true }).catch(() => {});
  }, 30_000);
});
