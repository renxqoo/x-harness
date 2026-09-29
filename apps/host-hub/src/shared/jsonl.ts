export interface JsonlChunk {
  lines: string[];
  oversize: number;
}

export interface JsonlLimits {
  maxLineBytes: number;
}

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
        discarding = false;
        continue;
      }
      if (raw.length > limits.maxLineBytes) {
        oversize += 1;
        continue;
      }
      const text = raw.toString("utf8");
      const line = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (line.trim() === "") continue;
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
        buffer = Buffer.alloc(0);
        discarding = true;
        return { lines: [], oversize: 1 };
      }
      return drain();
    },
    flush(): JsonlChunk {
      const result = drain();
      if (!discarding && buffer.length > 0 && buffer.toString("utf8").trim() !== "") {
        result.lines.push(buffer.toString("utf8"));
      }
      buffer = Buffer.alloc(0);
      discarding = false;
      return result;
    },
  };
}
