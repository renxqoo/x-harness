// jsonl 写面：两级打开（ax 全新 / EEXIST 可验证续写）、追加、fsync、关闭（docs/SESSION-RESUME §1.4）。
// 续写校验：尾态截断到最后换行 → 磁盘卷是当前日志前缀（规范化深度相等）∧ header 相等 → 'a' 续写并返回前缀长度；
// 任一不过重抛原 EEXIST（复用 plugin 的 dead 闩与 session-id-reused 报文）。

import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent, SessionHeader } from "@x-harness/session";
import { canonicallyEqual } from "./equal.ts";

export interface SessionWriter {
  /** lines 为已含尾换行的完整行；空数组为纯 sync 屏障 */
  append(lines: readonly string[]): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** 打开结果：prefixLength = 磁盘已落账前缀长度（全新 = 0；续写 = 磁盘卷长度）——首灌 pending 按它裁剪 */
export interface OpenedWriter {
  readonly writer: SessionWriter;
  readonly prefixLength: number;
}

export function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

export async function openSessionWriter(
  dir: string,
  header: SessionHeader,
  currentEvents: readonly SessionEvent[],
): Promise<OpenedWriter> {
  await mkdir(dir, { recursive: true }); // 会话目录惰性创建（幂等；重用/续写判定靠 ax/wx 与下方校验）
  const eventsPath = join(dir, "events.jsonl");
  const headerPath = join(dir, "header.json");

  let fh: FileHandle;
  try {
    fh = await open(eventsPath, "ax");
  } catch (axError) {
    if (!isEexistError(axError)) throw axError;
    return resumeSessionWriter({ dir, header, currentEvents, eexist: axError });
  }

  try {
    await writeFile(headerPath, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch (wxError) {
    if (isEexistError(wxError)) {
      // 孤儿 header（header 在、events 原不存在）：相等则续写空卷（k=0），不等则撤销 dead
      const diskHeader = await readHeaderFile(dir);
      if (diskHeader !== undefined && canonicallyEqual(diskHeader, header)) {
        return { writer: makeWriter(fh), prefixLength: 0 };
      }
    }
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

/** 尾态修复 + 磁盘卷解析：不以 \n 结尾则截到最后一个换行（半行丢弃；完整无尾换行行由 pending 重写） */
function parseDiskVolume(text: string, eexist: unknown): { readonly kept: string; readonly events: unknown[] } {
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
    if (line === "") throw eexist; // 修复后仍有空行 = 中间损坏
    try {
      events.push(JSON.parse(line));
    } catch {
      throw eexist; // 修复后仍不可解析 = 中间损坏
    }
  }
  return { kept, events };
}

async function resumeSessionWriter(input: {
  readonly dir: string;
  readonly header: SessionHeader;
  readonly currentEvents: readonly SessionEvent[];
  readonly eexist: unknown;
}): Promise<OpenedWriter> {
  const { dir, header, currentEvents, eexist } = input;
  const eventsPath = join(dir, "events.jsonl");
  const text = await readFile(eventsPath, "utf8");
  const { kept, events: diskEvents } = parseDiskVolume(text, eexist);

  const diskHeader = await readHeaderFile(dir);
  if (diskHeader === undefined || !canonicallyEqual(diskHeader, header)) throw eexist;

  if (diskEvents.length > currentEvents.length) throw eexist;
  for (let i = 0; i < diskEvents.length; i++) {
    if (!canonicallyEqual(diskEvents[i], currentEvents[i])) throw eexist;
  }

  const fh = await open(eventsPath, "a");
  if (kept.length < text.length) await fh.truncate(kept.length);
  return { writer: makeWriter(fh), prefixLength: diskEvents.length };
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
      if (lines.length > 0) await fh.appendFile(lines.join(""));
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  };
}
