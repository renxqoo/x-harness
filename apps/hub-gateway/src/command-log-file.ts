import { appendFile, mkdir, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "./identity.ts";

/** 单个设备命令日志的落盘上限：超过即重写文件，只留最新的若干条。
 * 内存环形缓冲（COMMAND_LOG_RING_MAX）管条数，本上限管字节——thread/list_saved
 * 一类命令单条可达数百 KB，只按条数封顶仍会产出数百 MB 文件。 */
export const COMMAND_LOG_BYTES_CAP = 32 * 1024 * 1024;

export interface CommandLogLine {
  commandId: string;
  ts: number;
  /** 压缩时丢弃响应体：幂等去重只需比对 bodyHash 与是否已应答。 */
  response?: unknown;
  [key: string]: unknown;
}

/** 读命令日志并按 commandId 合并（同一命令的追加行与响应行归一）。
 * 后出现的响应覆盖先出现的无响应记录；两条都带响应时取后写入的。 */
export async function readMergedCommandLog(path: string): Promise<CommandLogLine[]> {
  const merged = new Map<string, CommandLogLine>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as CommandLogLine;
      if (typeof rec.commandId !== "string") continue;
      const prev = merged.get(rec.commandId);
      merged.set(
        rec.commandId,
        prev === undefined || prev.response === undefined ? rec : { ...rec, response: rec.response ?? prev.response },
      );
    } catch {
      // 半行（崩溃时截断的追加）跳过；上一条完整记录已足够恢复状态
    }
  }
  return [...merged.values()];
}

/** 把合并后的记录重新落盘，压掉超出上限的旧记录。
 * 返回是否发生了重写，供调用方决定是否需要在内存侧同步同样截断。 */
export async function compactCommandLog(
  path: string,
  records: readonly CommandLogLine[],
  bytesCap: number,
): Promise<boolean> {
  const kept = takeWithinBytes(records, bytesCap);
  const body = kept.map((rec) => JSON.stringify(rec)).join("\n");
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, body.length === 0 ? "" : `${body}\n`);
  return kept.length < records.length;
}

/** 从尾部回取能装进字节上限的记录，保证至少留一条（否则 pending 命令补投的
 * hostId 映射会随之丢失，网关重启后未应答命令永远等不到响应）。 */
export function takeWithinBytes(records: readonly CommandLogLine[], bytesCap: number): CommandLogLine[] {
  let used = 0;
  const kept: CommandLogLine[] = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(JSON.stringify(records[i]!)) + 1;
    if (used + size > bytesCap && kept.length > 0) break;
    used += size;
    kept.push(records[i]!);
  }
  return kept.reverse();
}

export async function appendCommandLogLine(path: string, record: CommandLogLine): Promise<number> {
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(path, line, "utf8");
  return Buffer.byteLength(line);
}

/** 撤销设备时同步清掉其命令日志目录：remove() 是同步签名，fire-and-forget 会让
 * 调用方在删除真正生效前就认为设备已撤销，留下无主目录。 */
export function removeCommandLogSync(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}