// jsonl 写面：两级打开（ax 全新 / EEXIST 可验证续写）、追加（失败截断回滚）、fsync、关闭（docs/SESSION-RESUME §1.4）。
// 续写校验：尾态截断到最后换行 → 磁盘卷是当前日志前缀（规范化深度相等）∧ header 相等 → 'a' 续写并返回前缀长度；
// 拒绝按来源分类报文（session-id-reused / archive-orphan-events / archive-corrupt / archive-prefix-mismatch），
// 均标记 permanent——plugin 的 dead 闩据此闩死（区别于可重试的瞬时 I/O 错误）。

import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent, SessionHeader } from "@x-harness/session";
import { canonicallyEqual } from "./equal.ts";
import { acquireSessionLock } from "./lock.ts";
import type { SessionLock } from "./lock.ts";

export interface SessionWriter {
  /** lines 为已含尾换行的完整行；空数组为纯 sync 屏障。失败时截断回滚到批前长度再重抛（重试无重复字节） */
  append(lines: readonly string[]): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** 打开结果：prefixLength = 磁盘已落账前缀长度（全新 = 0；续写 = 磁盘卷长度）——首灌 pending 按它裁剪 */
export interface OpenedWriter {
  readonly writer: SessionWriter;
  readonly prefixLength: number;
}

/** 永久性拒绝（重用/档案损坏/前缀不符）：dead 闩依据；瞬时 I/O 错误不带此标记、可重试 */
export function isPermanentRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { permanent?: unknown }).permanent === true;
}

function permanentRejection(reason: string): Error {
  return Object.assign(new Error(reason), { permanent: true });
}

export function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

export async function openSessionWriter(
  dir: string,
  header: SessionHeader,
  currentEvents: readonly SessionEvent[],
): Promise<OpenedWriter> {
  await mkdir(dir, { recursive: true }); // 会话目录惰性创建（幂等；含 root 前缀）
  // 单写者锁先于任何卷操作（跨进程双开交织写防护，docs/CLI.md §2.6）；
  // 打开失败必须释放，否则一次失败永久占死会话
  const lock = await acquireSessionLock(dir, dirName(dir));
  let opened: OpenedWriter;
  try {
    opened = await openUnlocked(dir, header, currentEvents);
  } catch (error) {
    await lock.release();
    throw error;
  }
  return { writer: withLockRelease(opened.writer, lock), prefixLength: opened.prefixLength };
}

/** close 时随 fd 一并释放锁（先关 fd 后释放，任何路径都尽力而为） */
function withLockRelease(writer: SessionWriter, lock: SessionLock): SessionWriter {
  return {
    append: (lines) => writer.append(lines),
    sync: () => writer.sync(),
    close: async () => {
      try {
        await writer.close();
      } finally {
        await lock.release();
      }
    },
  };
}

async function openUnlocked(dir: string, header: SessionHeader, currentEvents: readonly SessionEvent[]): Promise<OpenedWriter> {
  const eventsPath = join(dir, "events.jsonl");
  const headerPath = join(dir, "header.json");

  let fh: FileHandle;
  try {
    fh = await open(eventsPath, "ax");
  } catch (axError) {
    if (!isEexistError(axError)) throw axError;
    return resumeSessionWriter({ dir, header, currentEvents });
  }

  try {
    await writeFile(headerPath, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch (wxError) {
    // 回滚各步独立兜错：close/unlink 自身的失败不得吞掉原始错误（残留空文件仅导致下次 ax EEXIST，可诊断）
    await fh.close().then(
      () => {},
      () => {},
    );
    await unlink(eventsPath).then(
      () => {},
      () => {},
    );
    throw wxError;
  }
  return { writer: makeWriter(fh), prefixLength: 0 };
}

async function resumeSessionWriter(input: {
  readonly dir: string;
  readonly header: SessionHeader;
  readonly currentEvents: readonly SessionEvent[];
}): Promise<OpenedWriter> {
  const { dir, header, currentEvents } = input;
  const eventsPath = join(dir, "events.jsonl");
  const text = await readFile(eventsPath, "utf8");
  const { kept, events: diskEvents } = parseDiskVolume(text, dir);

  const diskHeader = await readHeaderFile(dir);
  if (diskHeader === undefined) throw permanentRejection(`archive-orphan-events:${dirName(dir)}`);
  if (!canonicallyEqual(diskHeader, header)) throw permanentRejection(`session-id-reused:${dirName(dir)}`);

  if (diskEvents.length > currentEvents.length) throw permanentRejection(`archive-prefix-mismatch:${dirName(dir)}`);
  for (let i = 0; i < diskEvents.length; i++) {
    if (!canonicallyEqual(diskEvents[i], currentEvents[i])) {
      throw permanentRejection(`archive-prefix-mismatch:${dirName(dir)}`);
    }
  }

  const fh = await open(eventsPath, "a");
  if (kept.length < text.length) await fh.truncate(kept.length);
  return { writer: makeWriter(fh), prefixLength: diskEvents.length };
}

function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/** 尾态修复 + 磁盘卷解析：不以 \n 结尾则截到最后一个换行（半行丢弃；完整无尾换行行由 pending 重写） */
function parseDiskVolume(text: string, dir: string): { readonly kept: string; readonly events: unknown[] } {
  let kept = text;
  if (text !== "" && !text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    kept = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  }
  const lines = kept.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const events: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") throw permanentRejection(`archive-corrupt:${dirName(dir)}:blank-line`);
    try {
      events.push(JSON.parse(line));
    } catch {
      throw permanentRejection(`archive-corrupt:${dirName(dir)}:line${String(i)}`);
    }
  }
  return { kept, events };
}

async function readHeaderFile(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, "header.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function makeWriter(fh: FileHandle): SessionWriter {
  return {
    append: async (lines) => {
      if (lines.length === 0) return;
      const before = await fh.stat().then((stat) => stat.size);
      try {
        await fh.appendFile(lines.join(""));
      } catch (error) {
        // 截断回滚到批前长度：同进程重试不产生重复字节（跨进程由续写前缀校验自愈）
        await fh.truncate(before).then(
          () => {},
          () => {},
        );
        throw error;
      }
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  };
}
