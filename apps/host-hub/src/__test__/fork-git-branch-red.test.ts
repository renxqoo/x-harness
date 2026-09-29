import { afterAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startHost, drivePrompt } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const exec = promisify(execFile);

const hosts: HostHandle[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function gitRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "hub-forkgb-p-"));
  roots.push(parent);
  const dir = join(parent, "repo");
  await mkdir(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  await exec("git", ["-C", dir, "checkout", "-b", "feat/fork-gb"]);
  return dir;
}

describe("红测：fork 响应 data 缺 gitBranch（与 start/resume 形态不对称）", () => {
  test("git 仓 cwd start → fork → fork 响应无 gitBranch（start 响应有；装配期值在手边被丢）", async () => {
    const repo = await gitRepo();
    const host = await startHost({ script: [{ reply: "origin" }, { reply: "forked" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: repo, trusted: true, permissionMode: "full" });
    const started = await host.response("s1");
    expect(started.success).toBe(true);
    expect((started.data as { gitBranch?: string }).gitBranch).toBe("feat/fork-gb");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "root" });
    host.send({ type: "fork", id: "f1", threadId, seq: 3, position: "at" });
    const forked = await host.response("f1");
    expect(forked.success).toBe(true);
    expect((forked.data as { gitBranch?: string }).gitBranch).toBe("feat/fork-gb");
  }, 90_000);
});
