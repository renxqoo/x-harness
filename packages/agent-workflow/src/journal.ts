// journal WAL（docs/AGENT-WORKFLOW.md §3.1——writer.ts 工程语言平移）：
// per-run 串行链 append + 屏障 fsync + 失败截断回滚 + 撕裂截断到最后完整行。
// 恢复矩阵（§3.1）：目录删除=run 不存在；header 损坏=冻结；journal 尾撕裂=截断 fold；
// journal 中段损坏=冻结（对称 header 损坏——截尾救不了中段）。

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fold } from "@x-harness/workflow-core";
import type { RunSnapshot, WorkflowEvent } from "@x-harness/workflow-core";
import { acquireRunLock } from "./lock.ts";

const JOURNAL_NAME = "journal.jsonl";
const HEADER_NAME = "header.json";

export interface RunHeader {
  readonly runId: string;
  readonly parentSession: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly pluginVersion: string;
}

export interface JournalWriter {
  /** 追加事件（串行链——调用序即落盘序）；失败截断回滚到批前长度再重抛 */
  append(events: readonly WorkflowEvent[]): Promise<void>;
  /** 屏障 fsync */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenResult =
  | { readonly kind: "opened"; readonly writer: JournalWriter; readonly header: RunHeader; readonly snapshot: RunSnapshot | undefined }
  /** 活锁/接管竞态败——调用方跳过（§5.1） */
  | { readonly kind: "busy" }
  /** 恢复矩阵：header 损坏 / journal 中段损坏 → 冻结（不失败装配，onWarn 可达） */
  | { readonly kind: "frozen"; readonly reason: string };

export function workflowPluginVersion(): string {
  return "16.0.0";
}

/** 打开 run journal：新建（run/created 首事件随 caller 落）或接管（读卷 fold） */
export async function openRunJournal(root: string, header: RunHeader): Promise<OpenResult> {
  const dir = join(root, header.runId);
  await mkdir(dir, { recursive: true });
  const acquired = await acquireRunLock(dir);
  if (acquired.kind !== "acquired") return { kind: "busy" };
  try {
    await writeFile(join(dir, HEADER_NAME), `${JSON.stringify(header, null, 2)}\n`, { flag: "wx" }).catch(() => {
      /* 已在（接管形态）——重读校验 runId 一致性 */
    });
    const readBack = await readHeader(dir);
    if (readBack === undefined || readBack.runId !== header.runId) {
      await acquired.lock.release();
      return { kind: "frozen", reason: `header corrupt or mismatched for run ${header.runId}` };
    }
    const recovered = await recoverJournal(dir, true); // 已持锁——撕裂修复回写合法
    if (recovered.kind === "frozen") {
      await acquired.lock.release();
      return recovered;
    }
    const fh = await open(join(dir, JOURNAL_NAME), "a");
    const state: SerialState = { fh, dir, lines: recovered.length };
    const writer = serialWriter(state);
    return { kind: "opened", writer: withLockRelease(writer, acquired.lock), header: readBack, snapshot: recovered.snapshot };
  } catch (error) {
    await acquired.lock.release();
    throw error;
  }
}

/** 只读打开（启动扫描 §5.1——不取锁，只 fold 记账；不补动作的 run 用它） */
export async function readRun(root: string, runId: string): Promise<OpenResult> {
  const dir = join(root, runId);
  const header = await readHeader(dir);
  if (header === undefined) return { kind: "frozen", reason: `header missing for run ${runId}` };
  const recovered = await recoverJournal(dir, false); // A7：只读——无锁路径绝不回写
  if (recovered.kind === "frozen") return recovered;
  return { kind: "opened", writer: noopWriter, header, snapshot: recovered.snapshot };
}

/** 恢复矩阵 journal 侧：尾撕裂截断（前缀语义）；中段损坏冻结。
 *  repair=true 时撕裂残片回写盘上（仅限**已持锁**调用——A7：无锁回写会截断他进程
 *  正在 append 的活跃卷：读者眼里缓冲半行=撕裂，回写即毁卷）；只读路径 repair=false。 */
export async function recoverJournal(dir: string, repair = false): Promise<{ readonly kind: "ok"; readonly snapshot: RunSnapshot | undefined; readonly length: number } | { readonly kind: "frozen"; readonly reason: string }> {
  let raw: string;
  try {
    raw = await readFile(join(dir, JOURNAL_NAME), "utf8");
  } catch {
    return { kind: "ok", snapshot: undefined, length: 0 }; // 无卷（run/created 未落）——全新
  }
  const lines = raw.split("\n");
  const last = lines.pop() ?? ""; // 尾元素：完整行后为空串；撕裂残片非空
  const events: WorkflowEvent[] = [];
  let index = 0;
  for (const line of lines) {
    if (line === "") continue;
    const parsed = parseLine(line);
    if (parsed === undefined) {
      // 中段损坏：完整行但不可解析——冻结（截尾只救尾部半行）
      return index > 0 || lines.length > 1
        ? { kind: "frozen", reason: `journal corrupt at line ${String(index + 1)} (complete line unparseable)` }
        : { kind: "frozen", reason: `journal corrupt at line ${String(index + 1)}` };
    }
    events.push(parsed);
    index += 1;
  }
  // 尾撕裂：残片非空 → 持锁路径（repair）截断回写；只读路径不动盘（A7——下次持锁者修复）
  if (repair && last !== "") {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await writeFile(join(dir, JOURNAL_NAME), prefix, "utf8");
  }
  let snapshot: RunSnapshot | undefined;
  try {
    snapshot = fold(events);
  } catch (error) {
    return { kind: "frozen", reason: `journal events violate state machine: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { kind: "ok", snapshot, length: lines.filter((line) => line !== "").length };
}

async function readHeader(dir: string): Promise<RunHeader | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, HEADER_NAME), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const h = parsed as Record<string, unknown>;
    if (typeof h["runId"] !== "string" || typeof h["parentSession"] !== "string") return undefined;
    return {
      runId: h["runId"],
      parentSession: h["parentSession"],
      cwd: typeof h["cwd"] === "string" ? h["cwd"] : "",
      createdAt: typeof h["createdAt"] === "number" ? h["createdAt"] : 0,
      pluginVersion: typeof h["pluginVersion"] === "string" ? h["pluginVersion"] : "",
    };
  } catch {
    return undefined;
  }
}

function parseLine(line: string): WorkflowEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as WorkflowEvent;
  } catch {
    return undefined;
  }
}

// ————————————————————————— 写面（per-run 串行链 + 截断回滚 + 屏障 fsync——writer.ts 同款） —————————————————————————

interface SerialState {
  readonly fh: FileHandle;
  readonly dir: string;
  /** 已落行数（截断回滚的批前位点） */
  lines: number;
}

function serialWriter(state: SerialState): JournalWriter {
  const { fh, dir } = state;
  let chain: Promise<void> = Promise.resolve();
  const run = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task, task);
    return chain;
  };
  return {
    append: (events) =>
      run(async () => {
        if (events.length === 0) return;
        const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
        const before = state.lines;
        try {
          await fh.appendFile(lines);
          state.lines = before + events.length;
        } catch (error) {
          // 截断回滚到批前（重试无重复字节）
          const bytes = await byteLengthOf(dir, before).catch(() => 0);
          await fh.truncate(bytes).catch(() => {});
          throw error;
        }
      }),
    sync: () => run(() => fh.sync()),
    close: () => run(async () => {
      await fh.sync().catch(() => {});
      await fh.close();
    }),
  };
}

/** 截断回滚的字节长度：重算已落行总长（行数语义简单，字节按重读太贵——以行为幂等粒度，
 *  截断到位点 = 重建文件到 before 行。appendFile 部分写的行级撕裂由恢复矩阵兜底） */
async function byteLengthOf(dir: string, lineCount: number): Promise<number> {
  if (lineCount === 0) return 0;
  const raw = await readFile(join(dir, JOURNAL_NAME), "utf8").catch(() => "");
  const lines = raw.split("\n");
  const kept = lines.slice(0, lineCount);
  return kept.length === lineCount ? Buffer.byteLength(`${kept.join("\n")}\n`, "utf8") : 0;
}

const noopWriter: JournalWriter = {
  append: () => Promise.reject(new Error("read-only journal")),
  sync: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

function withLockRelease(writer: JournalWriter, lock: { readonly release: () => Promise<void> }): JournalWriter {
  let released = false;
  return {
    append: (events) => writer.append(events),
    sync: () => writer.sync(),
    close: async () => {
      try {
        await writer.close();
      } finally {
        if (!released) {
          released = true;
          await lock.release();
        }
      }
    },
  };
}
