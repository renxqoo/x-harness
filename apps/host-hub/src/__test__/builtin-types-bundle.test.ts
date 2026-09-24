// 打包形态 builtin 类型装载回归：worker 从 dist 产物运行（bundle 内联资源——无盘上
// agent-types 目录依赖）。历史症状：builtinTypesDir() 按 import.meta.dirname 相对
// 寻址 `../../agent-types`，dist 布局（dist/host/cli.js）下解析到不存在的路径且
// 目录缺席静默 continue——agents 清单空。回归锁：内联资源层在任意运行形态恒装载。
import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";

import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hosts: HostHandle[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

/** dist 产物入口（bun run build 产物；无该产物的环境先跑 build） */
function distEntry(): string {
  return join(import.meta.dirname, "../../dist/host/cli.js");
}

describe("打包形态 builtin 类型装载（dist 产物 + 无盘上 agent-types）", () => {
  test("agents/list 含 builtin 层（explore/general-purpose——内联资源不依赖盘上目录）", async () => {
    const host = await startHost({ entry: distEntry(), script: [{ reply: "ok" }] });
    hosts.push(host);

    host.send({ type: "agents/list", id: "al1" });
    const listed = await host.response("al1");
    expect(listed.success).toBe(true);
    const rows = (listed.data as { agents: Array<{ name: string; source: string }> }).agents;
    expect(rows.find((row) => row.name === "explore")?.source).toBe("builtin");
    expect(rows.find((row) => row.name === "general-purpose")?.source).toBe("builtin");
  }, 60_000);

  test("worker 装配类型快照含 builtin 层（spawn 侧可见——与 agents/list 同源）", async () => {
    const host = await startHost({ entry: distEntry(), script: [{ reply: "ok" }] });
    hosts.push(host);

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
    expect(text).toContain("general-purpose");
    expect(text).toContain("explore");
  }, 60_000);
});
