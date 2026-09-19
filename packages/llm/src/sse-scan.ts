// SSE 行扫描底座（docs/LLM.md §1.5 共享件）：字节流 → data payload 序列。
// 跨 read 行缓冲、多字节防撕裂（TextDecoder stream + EOF 终 flush）、CRLF、注释/event:/id: 行跳过、
// data 空载荷跳过、终止符回调停读、先 cancel 再 releaseLock（releaseLock 后 cancel 无效——连接悬挂）。
// 协议知识零注入：终止判定归消费方回调。

export interface ScanOptions {
  /** 终止符判定（可带副作用记录状态）；返回 true → 停读（该 payload 不产出） */
  readonly isTerminator: (payload: string) => boolean;
}

/** 单行 → data payload；非 data 行（注释/event:/id:/空行）与空载荷 → undefined */
export function sseDataPayload(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  return payload === "" ? undefined : payload;
}

export async function* scanDataFrames(body: ReadableStream<Uint8Array>, options: ScanOptions): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminated = false;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;

      buffer += decoder.decode(read.value, { stream: true });
      yield* drainLines();
      if (terminated) break;
    }
    buffer += decoder.decode(); // EOF 终 flush：多字节残量解码

    if (buffer.length > 0 && !terminated) yield* drainFinalLine();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  function* drainLines(): Generator<string> {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trimEnd(); // CRLF 由 trimEnd 吸收
      buffer = buffer.slice(newline + 1);
      const payload = sseDataPayload(line);
      if (payload === undefined) continue;
      if (options.isTerminator(payload)) {
        buffer = "";
        terminated = true;
        return;
      }
      yield payload;
    }
  }

  /** EOF 残量（无尾换行的最后一帧）按整行处理——半行帧不丢 */
  function* drainFinalLine(): Generator<string> {
    const line = buffer.trimEnd();
    buffer = "";
    if (line === "") return;
    const payload = sseDataPayload(line);
    if (payload === undefined) return;
    if (options.isTerminator(payload)) return;
    yield payload;
  }
}
