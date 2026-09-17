// jsonl 写面：排他打开（events 'ax' → header 'wx'）、追加、fsync、关闭（docs/SESSION.md §1.8）。
// 任一 EEXIST = 同 id 重用 → 抛出上浮（桥接层判 dead）；wx 失败撤销刚建的空 events.jsonl。

import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionHeader } from "@x-harness/session";

export interface SessionWriter {
  /** lines 为已含尾换行的完整行；空数组为纯 sync 屏障 */
  append(lines: readonly string[]): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

export async function openSessionWriter(dir: string, header: SessionHeader): Promise<SessionWriter> {
  await mkdir(dir, { recursive: true }); // 会话目录惰性创建（已存在时幂等；重用检测靠下方 ax/wx 排他）
  const eventsPath = join(dir, "events.jsonl");
  const fh = await open(eventsPath, "ax");
  try {
    await writeFile(join(dir, "header.json"), `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch (error) {
    // 回滚各步独立兜错：close/unlink 自身的失败不得吞掉原始错误（残留空文件仅导致下次 ax EEXIST，可诊断）
    await fh.close().then(
      () => {},
      () => {},
    );
    // 撤销本会话刚建的空 events.jsonl（尚未写入任何行）；撤销失败仅残留空文件，旧档本无事件文件
    await unlink(eventsPath).then(
      () => {},
      () => {},
    );
    throw error;
  }
  return {
    append: async (lines) => {
      if (lines.length > 0) await fh.appendFile(lines.join(""));
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  };
}
