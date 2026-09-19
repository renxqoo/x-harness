// sse-scan 单元：无预读缓冲性质（完整行先于下一次 read 交出）、半行跨 read 重组、
// 终止符停读、CRLF/注释跳过、EOF 无尾换行残行——确定性事件序断言，零定时器。

import { describe, expect, it } from "vitest";
import { scanDataFrames, sseDataPayload } from "../sse-scan.ts";

function scriptedStream(chunks: string[], log: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        log.push(`read:${String(next)}`);
        const chunk = chunks[next];
        next += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(enc.encode(chunk));
      },
    },
    // HWM=0 严格按需：pull 仅在 scanner 发起 read 且队列空时发生——剥离流层预取，
    // read:N 与 yield 的交错才纯粹反映扫描器自己的交出时机
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
}

async function collect(stream: ReadableStream<Uint8Array>, log: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of scanDataFrames(stream, { isTerminator: (p) => p === "[DONE]" })) {
    log.push(`yield:${payload}`);
    out.push(payload);
  }
  return out;
}

describe("scanDataFrames（docs/LLM.md §1.5 共享件）", () => {
  it("无预读缓冲：完整行先于下一次 read 交出；半行跨 read 重组后才交出", async () => {
    const log: string[] = [];
    const payloads = await collect(
      scriptedStream(["data: a\n\n", "data: b\n\ndata: c\n\n", "data: d", "\n\n", "data: [DONE]\n\n"], log),
      log,
    );
    expect(payloads).toEqual(["a", "b", "c", "d"]);
    // 事件序即性质：yield:b/yield:c 紧随 read:1、先于 read:2（不预读）；
    // read:2 半行无 yield、read:3 补齐后 yield:d 先于 read:4；终止符 read:4 后停止
    expect(log).toEqual([
      "read:0",
      "yield:a",
      "read:1",
      "yield:b",
      "yield:c",
      "read:2",
      "read:3",
      "yield:d",
      "read:4",
    ]);
  });

  it("终止符停读：[DONE] 当次即停、不产出该 payload、不再发起后续 read", async () => {
    const log: string[] = [];
    const payloads = await collect(scriptedStream(["data: a\n\n", "data: [DONE]\n\n", "data: never\n\n"], log), log);
    expect(payloads).toEqual(["a"]);
    expect(log).toEqual(["read:0", "yield:a", "read:1"]); // read:2 永不发生
  });

  it("CRLF/注释/event:/id:/空载荷跳过；EOF 无尾换行的残行整行处理", async () => {
    const log: string[] = [];
    const payloads = await collect(
      scriptedStream([": comment\r\n\r\nevent: x\r\ndata: crlf\r\n\r\ndata:\n\ndata: tail-no-newline"], log),
      log,
    );
    expect(payloads).toEqual(["crlf", "tail-no-newline"]);
  });
});

describe("sseDataPayload 行投影", () => {
  it("非 data 行与空载荷 → undefined；data 前缀剥除", () => {
    expect(sseDataPayload("data: x")).toBe("x");
    expect(sseDataPayload("data:x")).toBe("x");
    expect(sseDataPayload(": ping")).toBeUndefined();
    expect(sseDataPayload("event: a")).toBeUndefined();
    expect(sseDataPayload("data:")).toBeUndefined();
    expect(sseDataPayload("data:   ")).toBeUndefined();
  });
});
