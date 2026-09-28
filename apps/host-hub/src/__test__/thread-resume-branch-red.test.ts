// 核实（对抗审查——worker 面）：thread/resume 的 gitBranch 锚 fields.cwd 是否
// 可被未归一 header.cwd 带偏。结论：**不可达**——相对 cwd 在装配期先被
// agent-delegation 的 workspaceRoot 绝对路径校验拒（plugin.ts:293），resume 应答
// failure、无 gitBranch 可言。本文件保留该守卫的回归锚（若未来校验放松/前移 gitBranch
// 产出位点，此锚即红——防线显性化）。

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnScriptWorker, waitResponse } from "./kit/worker-harness.ts";

const exec = promisify(execFile);

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

describe("worker 侧 resume gitBranch 锚守卫（防线回归锚）", () => {
  const previousCwd = process.cwd();

  beforeAll(async () => {
    const parent = await tempDir("hub-resguard-p-");
    const dir = join(parent, "repo");
    await mkdir(dir);
    await exec("git", ["-C", dir, "init"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
    await exec("git", ["-C", dir, "config", "user.name", "t"]);
    await writeFile(join(dir, "README.md"), "seed\n");
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "commit", "-m", "seed"]);
    await exec("git", ["-C", dir, "checkout", "-b", "victim/repo-branch"]);
    process.chdir(dir); // worker 进程 cwd 停真仓（内嵌装置同进程）——若锚泄漏即见该分支
    await mkdir(join(dir, "relwork"), { recursive: true });
  });

  afterAll(() => {
    process.chdir(previousCwd);
  });

  test("header.cwd=相对串 → resume failure（workspaceRoot 绝对路径守卫先拒）——无 gitBranch 产出", async () => {
    const w = await spawnScriptWorker({ script: [{ reply: "ok" }] });
    try {
      const sid = "relhdr0001";
      const dir = join(w.sessionsRoot, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd: "relwork" }), "utf8");
      const events = [
        { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
        { type: "session/meta", seq: 1, time: 2, data: { key: "title", value: "resumable" } },
      ];
      await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"), "utf8");
      w.send({ type: "thread/resume", id: "r1", sessionPath: join(dir, "events.jsonl") });
      const res = await waitResponse(w.captured.lines, "thread/resume", "r1");
      // 守卫在场：相对 cwd 装配失败（fail-loud），不会产出锚在宿主 cwd 的 gitBranch
      expect(res.success).toBe(false);
      expect((res.data as { gitBranch?: string } | undefined)?.gitBranch).toBeUndefined();
    } finally {
      w.input.end();
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }
  }, 30_000);
});
