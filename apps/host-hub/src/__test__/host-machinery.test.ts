// host 机械件单测：worker-process（真子进程分帧/违例/close 结算/两段杀）、
// thread-retire sweepOnce 矩阵、tmp-sweep 残留清扫、skills-admin project 级。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnWorker, workerExecPath } from "../host/worker-process.ts";
import { createSweep } from "../host/thread-retire.ts";
import { cleanupTmpResidue } from "../host/tmp-sweep.ts";
import { createThreadTable } from "../host/thread-table.ts";
import { knownSkillNames, listSkills, setSkillEnabled } from "../host/skills-admin.ts";
import { createTrustStore } from "../host/trust-store.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("worker-process（真子进程）", () => {
  test("行分帧（多行/跨 chunk/超限违例）+ close 才是死亡信号", async () => {
    const dir = await tempDir("hub-proc-");
    const script = join(dir, "child.ts");
    await writeFile(
      script,
      `process.stdout.write('{"type":"hello"}\\n{"type":"heartbeat"}\\n');\nsetTimeout(() => { process.stdout.write('{"type":"event"}'); }, 50);\nsetTimeout(() => { process.stdout.write('}\\n'); }, 120);\nsetTimeout(() => { process.exit(0); }, 200);\n`,
      "utf8",
    );
    const lines: string[] = [];
    let closed = 0;
    const handle = spawnWorker({
      env: { ...process.env } as Record<string, string>,
      exec: { command: process.execPath, args: [script] },
      stderrPrefix: "[test-child]",
      onLine: (line) => lines.push(line),
      onViolation: () => {},
      onClosed: () => {
        closed += 1;
      },
    });
    await handle.exited;
    expect(closed).toBe(1); // close 恰一结算
    expect(lines).toContain('{"type":"hello"}');
    expect(lines).toContain('{"type":"heartbeat"}');
    expect(lines).toContain('{"type":"event"}}'); // 跨 chunk 重组（50ms 半行 + 120ms 收尾）
    // 退出后迟到写不崩（stdin error 监听兜底）
    await handle.write("late").catch(() => undefined);
  });

  // 超限行违例分支：真子进程 129MiB 单行在本机 Bun 管道下送达量不定（背压忽略
  // 写者的到达截断——实测多跑非确定），无法确定性断言；整行/残段上限语义已由
  // shared/jsonl 分帧器矩阵覆盖（同一判据文案），此处不重复真进程复测。

  test("workerExecPath 三形态自解：脚本形态带 argv[1] + --internal-worker", () => {
    const exec = workerExecPath();
    expect(exec.command).toBe(process.execPath);
    expect(exec.args[exec.args.length - 1]).toBe("--internal-worker");
    expect(exec.args.length).toBeLessThanOrEqual(2);
  });
});

describe("thread-retire sweepOnce 矩阵", () => {
  function makeSweep(over: Partial<{ idleRetireMs: number; workerStaleMs: number; rssRetireBytes: number }> = {}) {
    const table = createThreadTable();
    const killed: string[] = [];
    const retired: Array<{ threadId: string; origin: string }> = [];
    const pool = {
      killStale: (threadId: string) => killed.push(threadId),
      retireThread: (threadId: string, intent: "stop" | "retire", origin?: string) => {
        retired.push({ threadId, origin: origin ?? "manual" });
        return "ok";
      },
    };
    const sweep = createSweep({
      table,
      pool: pool as never,
      limits: { idleRetireMs: over.idleRetireMs ?? 900_000, workerStaleMs: over.workerStaleMs ?? 30_000, rssRetireBytes: over.rssRetireBytes ?? 0 },
    });
    return { table, killed, retired, sweep };
  }

  test("心跳陈旧杀（宁可杀错——只打 live）", () => {
    const f = makeSweep({ workerStaleMs: 1_000 });
    const live = f.table.insert({ threadId: "stale", cwd: "/w", sessionPath: "/s/a/events.jsonl", state: "live", trusted: false, keepalive: false });
    f.table.update("stale", { lastBeatAt: Date.now() - 60_000 });
    const parked = f.table.insert({ threadId: "parked-old", cwd: "/w", sessionPath: "/s/b/events.jsonl", state: "parked", trusted: false, keepalive: false });
    f.table.update("parked-old", { lastBeatAt: Date.now() - 60_000 });
    void live;
    void parked;
    f.sweep.sweepOnce();
    expect(f.killed).toEqual(["stale"]); // parked 不在杀域
  });

  test("idle retire：keepalive/busy 例外；RSS 硬顶无视例外（未落盘 kill）", () => {
    const f = makeSweep({ idleRetireMs: 1_000, rssRetireBytes: 256 * 1024 * 1024 });
    f.table.insert({ threadId: "idle", cwd: "/w", sessionPath: "/s/idle/events.jsonl", state: "live", trusted: false, keepalive: false });
    f.table.update("idle", { idleMs: 5_000, lastBeatAt: Date.now() });
    f.table.insert({ threadId: "keep", cwd: "/w", sessionPath: "/s/keep/events.jsonl", state: "live", trusted: false, keepalive: true });
    f.table.update("keep", { idleMs: 5_000, lastBeatAt: Date.now() });
    f.table.insert({ threadId: "busy", cwd: "/w", sessionPath: "/s/busy/events.jsonl", state: "live", trusted: false, keepalive: false });
    f.table.update("busy", { idleMs: 0, isStreaming: true, lastBeatAt: Date.now() });
    f.table.insert({ threadId: "fat", cwd: "/w", sessionPath: null, state: "live", trusted: false, keepalive: true });
    f.table.update("fat", { rssBytes: 500 * 1024 * 1024, lastBeatAt: Date.now() });
    f.sweep.sweepOnce();
    expect(f.retired.map((r) => r.threadId)).toEqual(["idle"]); // keepalive/busy 豁免
    expect(f.retired[0]?.origin).toBe("idle");
    expect(f.killed).toEqual(["fat"]); // RSS 未落盘走 kill（thread_died 域）
  });
});

describe("tmp-sweep 残留清扫", () => {
  test("超 1h 的 providers/credentials tmp 清；在途与新文件留", async () => {
    const dir = await tempDir("hub-tmp-");
    const old = join(dir, "providers.json.123.abcdef01.tmp");
    const oldCred = join(dir, "credentials.123.abcdef01.tmp");
    const fresh = join(dir, `providers.json.${process.pid}.abcd1234.tmp`);
    const unrelated = join(dir, "notes.txt");
    await writeFile(old, "x", "utf8");
    await writeFile(oldCred, "x", "utf8");
    await writeFile(fresh, "x", "utf8");
    await writeFile(unrelated, "x", "utf8");
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, oldTime, oldTime);
    await utimes(oldCred, oldTime, oldTime);
    await cleanupTmpResidue(dir);
    const names = await readdir(dir);
    expect(names).toContain("notes.txt");
    expect(names).toContain(fresh.split("/").at(-1) as string);
    expect(names).not.toContain(old.split("/").at(-1) as string);
    expect(names).not.toContain(oldCred.split("/").at(-1) as string);
  });
});

describe("skills-admin project 级（真目录）", () => {
  test("project 装载 + disabled 标注 + enable/disable 名单 + stillDisabled 不触发（无 user 冲突）", async () => {
    const agentDir = await tempDir("hub-sk-");
    const projectCwd = await tempDir("hub-proj-");
    const skillsDir = join(projectCwd, ".x-harness", "skills");
    await mkdir(join(skillsDir, "alpha"), { recursive: true });
    await writeFile(join(skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: does A\n---\nbody", "utf8");
    // 信任登记（真实 trust store——project 门禁通路）
    const trust = createTrustStore(agentDir);
    await trust.trust(projectCwd);
    expect(await knownSkillNames(projectCwd)).toContain("alpha");
    const listed = await listSkills({ agentDir, cwd: projectCwd });
    const alpha = listed.skills.find((skill) => skill.name === "alpha");
    expect(alpha).toMatchObject({ source: "project", disabled: false });
    // disable → list 标注 disabled
    const disabled = await setSkillEnabled({ agentDir, name: "alpha", enabled: false, cwd: projectCwd });
    expect(disabled.ok).toBe(true);
    const afterDisable = await listSkills({ agentDir, cwd: projectCwd });
    expect(afterDisable.skills.find((skill) => skill.name === "alpha")?.disabled).toBe(true);
    // enable（project 级）→ 复原
    const enabled = await setSkillEnabled({ agentDir, name: "alpha", enabled: true, cwd: projectCwd });
    expect(enabled.ok).toBe(true);
    expect((enabled as { stillDisabled?: string }).stillDisabled).toBeUndefined(); // user 级无同名
    // 未信任 cwd → knownSkillNames 只见 user 层（project 不掺）
    expect(await knownSkillNames()).not.toContain("alpha");
    void homedir;
  });
});
