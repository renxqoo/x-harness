// plugins/list 装载态聚合回归（症状：已启用插件恒「待装载」）：host 归并输入必须
// 来自 live worker 的 get_plugins 快照聚合——admin-commands 曾漏传 spec.loaded，
// 任何已启用插件在 UI 上永远 unloaded。真进程黑盒：thread/start（装配装载 builtin）
// → plugins/list 应报 active；无 live 会话时 builtin 报 unloaded。
import { afterAll, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";
import { installPlugin } from "../host/plugins-install.ts";

const hostsClosed: HostHandle[] = [];
afterAll(async () => {
  for (const host of hostsClosed) host.end();
  await Promise.all(hostsClosed.map((host) => host.exited().catch(() => -1)));
});

describe("plugins/list 装载态聚合（真进程）", () => {
  test("live 会话在场：builtin 装载报 active；无 live 会话报 unloaded", async () => {
    const host = await startHost({ script: [{ reply: "list-ok" }] });
    hostsClosed.push(host);

    const statusOf = async (id: string): Promise<Record<string, string>> => {
      host.send({ type: "plugins/list", id });
      const outcome = await host.response(id);
      expect(outcome.success).toBe(true);
      const rows = (outcome.data as { plugins: Array<{ name: string; status: string }> }).plugins;
      return Object.fromEntries(rows.map((row) => [row.name, row.status]));
    };

    // 无 live 会话：builtin（token-analytics）unloaded——装配前语义，非故障
    const before = await statusOf("pl-before");
    expect(before["token-analytics"]).toBe("unloaded");

    // 起会话：装配期装载 builtin → 聚合应报 active
    host.send({ type: "thread/start", id: "ts1", cwd: host.agentDir });
    const started = await host.response("ts1");
    expect(started.success).toBe(true);

    const after = await statusOf("pl-after");
    expect(after["token-analytics"]).toBe("active");
  }, 30_000);

  test("vendor 插件同样聚合：install → 会话装配 → active", async () => {
    const host = await startHost({ script: [{ reply: "vendor-ok" }] });
    hostsClosed.push(host);

    // 造第三方插件源并装入该 host 的 agentDir
    const srcRoot = join(host.agentDir, "src-plugin");
    await mkdir(srcRoot, { recursive: true });
    await writeFile(join(srcRoot, "plugin.json"), JSON.stringify({ name: "agg-probe", kind: "third-party", apiVersion: 1 }));
    await writeFile(join(srcRoot, "index.ts"), "export default { name: 'agg-probe', apply(_ctx, caps) { void caps; } };");
    const installed = await installPlugin({ sourcePath: srcRoot, agentDir: host.agentDir });
    expect(installed.ok).toBe(true);

    host.send({ type: "thread/start", id: "ts2", cwd: host.agentDir });
    const started = await host.response("ts2");
    expect(started.success).toBe(true);

    host.send({ type: "plugins/list", id: "pl-vendor" });
    const outcome = await host.response("pl-vendor");
    expect(outcome.success).toBe(true);
    const rows = (outcome.data as { plugins: Array<{ name: string; status: string }> }).plugins;
    expect(rows.find((row) => row.name === "agg-probe")?.status).toBe("active");
  }, 30_000);
});
