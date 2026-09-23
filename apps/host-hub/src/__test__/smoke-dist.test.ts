// 双形态冒烟（MIGRATION §5 双形态移植）：bun build 产物（dist/cli.js）起真 host
// 进程——产物形态 worker 自举（cli.js 内动态 import worker/main chunk）+
// /$bunfs/ 分支仅编译单文件形态（本产物为多文件——argv[1] 指向 dist/cli.js 即脚本
// 形态自解）。全链旅程 + EOF exit 0。
import { afterAll, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drivePrompt, startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hosts: HostHandle[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

describe("双形态冒烟（dist 产物）", () => {
  test("dist/cli.js 起 host：thread/start → prompt → settled → WAL → EOF exit 0（产物 worker 自举）", async () => {
    const host = await startHost({ script: [{ reply: "dist form reply" }], entry: join(import.meta.dirname, "../../dist/host/cli.js") });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "dist smoke" });
    host.send({ type: "get_state", id: "g1", threadId });
    const state = await host.response("g1");
    expect((state.data as { sessionId: string }).sessionId).toBe(threadId);
    host.end();
    const code = await host.exited();
    expect(code).toBe(0);
  }, 90_000);

  test("dist 外部插件装载：get_token_analytics 应答（运行时 resolve——node_modules 链）+ 产物无内联绝对路径", async () => {
    // 产物断言：resolve 保持运行时调用，未被 bundler 静态内联为本机绝对路径（可迁移性）
    const main = await readFile(join(import.meta.dirname, "../../dist/worker/main.js"), "utf8");
    expect(main).toContain("import.meta.resolve");
    expect(main).not.toMatch(/\/[^"']*packages\/token-analytics\/src\/index\.ts/);

    const host = await startHost({ script: [{ reply: "dist analytics" }], entry: join(import.meta.dirname, "../../dist/host/cli.js") });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "dist analytics smoke" });
    host.send({ type: "get_token_analytics", id: "ta1", threadId });
    const res = await host.response("ta1");
    expect(res.success).toBe(true);
    const data = res.data as { breakdown: Record<string, number>; sessionOutput: number };
    expect(data.breakdown["lastReportedInput"]).toBe(64); // script adapter 实报（dist 形态同源）
    expect(data.breakdown["totalOutputTokens"]).toBe(16 + "dist analytics".length);
    expect(data.sessionOutput).toBe(16 + "dist analytics".length);
    host.end();
    const code = await host.exited();
    expect(code).toBe(0);
  }, 90_000);
});
