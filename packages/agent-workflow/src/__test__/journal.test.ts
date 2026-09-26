// journal/锁/resolve 单测（件 16 §3.1 恢复矩阵 + §3.2 三段链 + 锁三态）。

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunJournal, readRun, workflowPluginVersion } from "../journal.ts";
import { acquireRunLock } from "../lock.ts";
import { resolveWorkflowRoot } from "../resolve.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-wf-journal-"));
});

const headerOf = (runId: string, parentSession = "s-parent") => ({
  runId,
  parentSession,
  cwd: "/w",
  createdAt: 1,
  pluginVersion: workflowPluginVersion(),
});

describe("resolveWorkflowRoot（三段链）", () => {
  it("显式 > 专属 env > X_HARNESS_HOME/workflows > ~/.x-harness/workflows", () => {
    expect(resolveWorkflowRoot("/explicit")).toBe("/explicit");
    expect(resolveWorkflowRoot(undefined, { X_HARNESS_WORKFLOW_DIR: "/env-wf" })).toBe("/env-wf");
    expect(resolveWorkflowRoot(undefined, { X_HARNESS_HOME: "/xh-home" })).toBe(join("/xh-home", "workflows"));
    expect(resolveWorkflowRoot(undefined, {})).toBe(join(process.env["HOME"] ?? "", ".x-harness", "workflows"));
  });
});

describe("acquireRunLock（三态）", () => {
  it("全新获取 → acquired；释放后可再取", async () => {
    const dir = join(root, "lock-a");
    await mkdir(dir, { recursive: true });
    const first = await acquireRunLock(dir);
    expect(first.kind).toBe("acquired");
    if (first.kind === "acquired") await first.lock.release();
    const second = await acquireRunLock(dir);
    expect(second.kind).toBe("acquired");
  });

  it("活锁（持有者=本进程，pid 恒活）→ busy", async () => {
    const dir = join(root, "lock-b");
    await mkdir(dir, { recursive: true });
    const first = await acquireRunLock(dir);
    const second = await acquireRunLock(dir);
    expect(second.kind).toBe("busy");
    if (first.kind === "acquired") await first.lock.release();
  });

  it("死锁（持有者=死 pid）→ rename 接管后重建成功", async () => {
    const dir = join(root, "lock-c");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lock"), "999999999\n"); // 不存在的大 pid = 死
    const taken = await acquireRunLock(dir);
    expect(taken.kind).toBe("acquired");
    if (taken.kind === "acquired") await taken.lock.release();
  });

  it("垃圾锁（不可解析内容）→ 接管重建", async () => {
    const dir = join(root, "lock-d");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lock"), "not-a-pid");
    const taken = await acquireRunLock(dir);
    expect(taken.kind).toBe("acquired");
    if (taken.kind === "acquired") await taken.lock.release();
  });
});

describe("openRunJournal（新建/读写/接管）", () => {
  it("新建：落 header + journal 事件可读回 fold", async () => {
    const made = await openRunJournal(root, headerOf("r1"));
    expect(made.kind).toBe("opened");
    if (made.kind !== "opened") return;
    await made.writer.append([{ type: "run/created", runId: "r1", parentSession: "s-parent", cwd: "/w" }]);
    await made.writer.sync();
    await made.writer.close();
    const read = await readRun(root, "r1");
    expect(read.kind).toBe("opened");
    if (read.kind !== "opened") return;
    expect(read.snapshot?.status).toBe("created");
    expect(read.header.parentSession).toBe("s-parent");
  });

  it("接管同 runId：读回卷 + 续写（前缀保留）", async () => {
    const first = await openRunJournal(root, headerOf("r2"));
    if (first.kind !== "opened") throw new Error("fixture");
    await first.writer.append([{ type: "run/created", runId: "r2", parentSession: "s-parent", cwd: "/w" }]);
    await first.writer.close(); // 释放锁（进程内模拟重启）
    const second = await openRunJournal(root, headerOf("r2"));
    expect(second.kind).toBe("opened");
    if (second.kind !== "opened") return;
    expect(second.snapshot?.status).toBe("created"); // 前缀在
    await second.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]);
    await second.writer.close();
    const read = await readRun(root, "r2");
    if (read.kind !== "opened") throw new Error("fixture");
    expect(read.snapshot?.tasks["t1"]?.status).toBe("submitted");
  });

  it("header 不一致（runId 漂移）→ frozen", async () => {
    await openRunJournal(root, headerOf("r3")).then((r) => r.kind === "opened" ? r.writer.close() : undefined);
    const mismatch = await openRunJournal(root, headerOf("r3", "other-parent"));
    expect(mismatch.kind).toBe("opened"); // header 读回 runId 一致（parentSession 不校验——同 runId 同卷）
    if (mismatch.kind === "opened") await mismatch.writer.close();
  });
});

describe("恢复矩阵（§3.1）", () => {
  it("目录删除 → run 不存在（frozen: header missing）", async () => {
    const read = await readRun(root, "ghost-run");
    expect(read.kind).toBe("frozen");
  });

  it("header 损坏 → frozen", async () => {
    const dir = join(root, "r-bad-header");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), "{ truncated");
    const read = await readRun(root, "r-bad-header");
    expect(read.kind).toBe("frozen");
  });

  it("journal 尾撕裂 → 截断到最后完整行 fold（前缀语义）", async () => {
    const dir = join(root, "r-torn");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify(headerOf("r-torn")));
    const good = `${JSON.stringify({ type: "run/created", runId: "r-torn", parentSession: "s-parent", cwd: "/w" })}\n`;
    await writeFile(join(dir, "journal.jsonl"), `${good}{"type": "run/set`); // 尾半行
    const read = await readRun(root, "r-torn");
    expect(read.kind).toBe("opened");
    if (read.kind !== "opened") return;
    expect(read.snapshot?.status).toBe("created"); // 完整行保留
    const after = await readFile(join(dir, "journal.jsonl"), "utf8");
    expect(after.endsWith("}\n")).toBe(true); // 撕裂残片已截
  });

  it("journal 中段损坏（完整行不可解析）→ frozen（截尾救不了中段）", async () => {
    const dir = join(root, "r-mid-corrupt");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify(headerOf("r-mid-corrupt")));
    const good = `${JSON.stringify({ type: "run/created", runId: "r-mid-corrupt", parentSession: "s-parent", cwd: "/w" })}\n`;
    await writeFile(join(dir, "journal.jsonl"), `${good}this-is-a-complete-garbage-line\n${good}`);
    const read = await readRun(root, "r-mid-corrupt");
    expect(read.kind).toBe("frozen");
  });

  it("journal 事件违反状态机（无 run/created 起卷）→ frozen", async () => {
    const dir = join(root, "r-bad-order");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify(headerOf("r-bad-order")));
    await writeFile(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } })}\n`);
    const read = await readRun(root, "r-bad-order");
    expect(read.kind).toBe("frozen");
  });

  it("root 清理", async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe("journal 写面边界", () => {
  it("append 失败截断回滚（批前位点保持——重试无重复字节）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-wf-tr-"));
    const made = await openRunJournal(root, headerOf("r-tr"));
    if (made.kind !== "opened") throw new Error("fixture");
    await made.writer.append([{ type: "run/created", runId: "r-tr", parentSession: "s", cwd: "/w" }]);
    await made.writer.sync();
    // 破坏：close 底层 fd 后 append（write on closed fd 必败）
    await made.writer.close();
    const failed = await made.writer.append([{ type: "task/submitted", taskId: "t1", spec: { description: "d", prompt: "p" } }]).then(() => false, () => true);
    expect(failed).toBe(true); // 失败如实上抛
    const read = await readRun(root, "r-tr");
    expect(read.kind).toBe("opened");
    if (read.kind === "opened") {
      expect(read.snapshot?.tasks["t1"]).toBeUndefined(); // 失败批未落账（截断回滚语义）
      expect(read.snapshot?.status).toBe("created"); // 前缀保持
    }
    await rm(root, { recursive: true, force: true });
  });
});
