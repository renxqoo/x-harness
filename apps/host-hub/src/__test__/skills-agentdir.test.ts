// 技能目录 agentDir 派生回归（真进程）：HUB_AGENT_DIR 注入（agent-app 打包态形态）
// 时用户技能根 = <agentDir>/skills——skills/install 落位与 worker 装配装载同区。
// 缺省（CLI 独立）保持 ~/.x-harness/skills，由 loader 单测背书。
import { afterAll, describe, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hostsClosed: HostHandle[] = [];
const sources: string[] = [];
afterAll(async () => {
  for (const host of hostsClosed) host.end();
  await Promise.all(hostsClosed.map((host) => host.exited().catch(() => -1)));
  await Promise.all(sources.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("技能目录 agentDir 派生（真进程）", () => {
  test("skills/install 落 <agentDir>/skills；skills/list 可见；get_commands 目录面装载", async () => {
    const host = await startHost({ script: [{ reply: "skill-probe" }] });
    hostsClosed.push(host);

    // 源技能目录（host agentDir 内的 src，随临时区清理）
    const src = join(host.agentDir, "skill-src", "dirived-skill");
    sources.push(join(host.agentDir, "skill-src"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "---\nname: dirived-skill\ndescription: agentDir 派生回归技能\n---\nbody");

    // 安装 → 目标应在 <agentDir>/skills（而非 ~/.x-harness/skills）
    host.send({ type: "skills/install", id: "si1", sourcePath: src });
    const installed = await host.response("si1");
    expect(installed.success).toBe(true);
    const skillPath = (installed.data as { path: string }).path;
    expect(skillPath.startsWith(join(host.agentDir, "skills"))).toBe(true);
    expect(skillPath.includes(".x-harness")).toBe(false);

    // 清单可见（user 源）
    host.send({ type: "skills/list", id: "sl1" });
    const listed = await host.response("sl1");
    expect(listed.success).toBe(true);
    const rows = (listed.data as { skills: Array<{ name: string; source: string }> }).skills;
    expect(rows.find((row) => row.name === "dirived-skill")?.source).toBe("user");

    // 装配装载：起会话后 get_commands 目录面含该技能
    host.send({ type: "thread/start", id: "ts1", cwd: host.agentDir });
    const started = await host.response("ts1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "get_commands", id: "gc1", threadId });
    const commands = await host.response("gc1");
    expect(commands.success).toBe(true);
    const text = JSON.stringify(commands.data);
    expect(text).toContain("dirived-skill");

    // 装进来的副本可读（SKILL.md 内容随行）
    const copy = await readFile(join(host.agentDir, "skills", "dirived-skill", "SKILL.md"), "utf8");
    expect(copy).toContain("agentDir 派生回归技能");
  }, 30_000);

  test("skills/remove 删 agentDir 派生根内的副本", async () => {
    const host = await startHost({ script: [{ reply: "skill-remove" }] });
    hostsClosed.push(host);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const src = join(host.agentDir, "skill-src-2", "gone-skill");
    sources.push(join(host.agentDir, "skill-src-2"));
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "---\nname: gone-skill\ndescription: 待删\n---\nbody");
    host.send({ type: "skills/install", id: "si2", sourcePath: src });
    await host.response("si2");
    host.send({ type: "skills/remove", id: "sr2", name: "gone-skill" });
    const removed = await host.response("sr2");
    expect(removed.success).toBe(true);
    const { access } = await import("node:fs/promises");
    await expect(access(join(host.agentDir, "skills", "gone-skill"))).rejects.toThrow();
  }, 30_000);
});
