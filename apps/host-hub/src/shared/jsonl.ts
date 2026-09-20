// JSONL 分帧器（DESIGN §2）：LF 唯一记录分隔、容忍行尾 \r、空行忽略、超限整行丢弃
// 恰报一次。自研原因：Node readline 按 U+2028/U+2029 切行会劈开 JSON 字符串。
// 行长判定按 utf-8 字节真值（整行重组后计——完整行与无换行残段同一判据），
// 字符串域操作不劈码点。
export interface JsonlChunk {
  /** 完整行（去 \r、非空） */
  lines: string[];
  /** 超限被丢弃的行数（每行恰报一次） */
  oversize: number;
}

export interface JsonlLimits {
  /** 单行字节上限（host 面 16MiB / worker 面 128MiB） */
  maxLineBytes: number;
}

/** 增量分帧：feed 追加字节块，返回完整行；flush 取残尾（无换行尾行的收口）。
 *  字节域定界后整行一次解码——多字节字符跨 chunk 不劈裂。 */
export function createJsonlSplitter(limits: JsonlLimits): {
  feed(chunk: Buffer): JsonlChunk;
  flush(): JsonlChunk;
} {
  let buffer = Buffer.alloc(0);
  let discarding = false;

  function drain(): JsonlChunk {
    const lines: string[] = [];
    let oversize = 0;
    for (;;) {
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) break;
      const raw = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (discarding) {
        discarding = false; // 超限残段到行尾即恢复接收；该行已计数不再报
        continue;
      }
      if (raw.length > limits.maxLineBytes) {
        oversize += 1; // 完整超限行：整行丢弃恰报一次
        continue;
      }
      const text = raw.toString("utf8");
      const line = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (line.trim() === "") continue; // 空行忽略
      lines.push(line);
    }
    return { lines, oversize };
  }

  function residualOversize(): boolean {
    return buffer.indexOf(0x0a) === -1 && buffer.length > limits.maxLineBytes;
  }

  return {
    feed(chunk: Buffer): JsonlChunk {
      buffer = Buffer.concat([buffer, chunk]);
      if (discarding) {
        return drain();
      }
      if (residualOversize()) {
        // 无换行且残段已超限：丢弃并恰报一次，残段后续字节静默吸收
        buffer = Buffer.alloc(0);
        discarding = true;
        return { lines: [], oversize: 1 };
      }
      return drain();
    },
    flush(): JsonlChunk {
      const result = drain();
      if (!discarding && buffer.length > 0 && buffer.toString("utf8").trim() !== "") {
        // 超限残段在 feed 时已丢弃计数——flush 恒见合法残尾
        result.lines.push(buffer.toString("utf8"));
      }
      buffer = Buffer.alloc(0);
      discarding = false;
      return result;
    },
  };
}
