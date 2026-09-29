import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { StreamCleaner, createLogSink, pumpToSink } from "../log-sink.ts";
import { cleanAnsi } from "../collect.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-logsink-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("StreamCleaner 与 cleanAnsi 的流式等价（全前缀劈法性质断言）", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const samples: readonly string[] = [
    "plain text",
    "crlf\r\nkeep\r\n",
    "bare\rcr\r",
    `${ESC}[31mred${ESC}[0mplain`,
    `${ESC}]0;title${BEL}after`,
    `${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\done`,
    `mix${ESC}[1;32m\r\n${ESC}[0mtail`,
    `${ESC}[?25lhide${ESC}[?25h`,
    `dangling-esc${ESC}`,
    `${ESC}[12`,
    `${ESC}]osc-no-term`,
    `${ESC}]a${ESC}\\b${BEL}c`,
    `${ESC}]a${ESC}\\b${ESC}\\c`,
    `${ESC}[unclosed\nnewline-after`,
    `${ESC}z-not-a-sequence`,
  ];

  it("任意两段劈法 + 单字节步进均与全文清洗等价", () => {
    for (const sample of samples) {
      const whole = cleanAnsi(sample);
      for (let i = 1; i < sample.length; i += 1) {
        const two = new StreamCleaner();
        expect(two.step(sample.slice(0, i)) + two.step(sample.slice(i)) + two.end()).toBe(whole);
      }
      const bytewise = new StreamCleaner();
      let stepped = "";
      for (const ch of sample) stepped += bytewise.step(ch);
      expect(stepped + bytewise.end()).toBe(whole);
    }
  });

  it("\\r\\n 劈在 chunk 边界保留 CRLF（裸 \\r 仍删）", () => {
    const cleaner = new StreamCleaner();
    const first = cleaner.step("a\r");
    const second = cleaner.step("\nb\rc");
    expect(first + second + cleaner.end()).toBe("a\r\nbc");
  });

  it("EOF 悬置 \\r 丢弃（其后必无 \\n——裸 \\r 语义成立）", () => {
    const cleaner = new StreamCleaner();
    expect(cleaner.step("tail\r") + cleaner.end()).toBe("tail");
  });
});

describe("createLogSink 写帽", () => {
  it("字节精确截断 + 截断点 UTF-8 续字节回退（不撕裂多字节字符）+ 前缀保留", async () => {
    const path = join(root, "cap.log");
    const sink = createLogSink(path, 10);
    sink.accept("€€€€");
    await sink.close();
    expect(readFileSync(path, "utf8")).toBe("€€€");
    expect(sink.stats().writtenBytes).toBe(9);
    expect(sink.stats().droppedBytes).toBe(3);
    expect(sink.stats().truncated).toBe(true);
  });

  it("帽后继续到达的输出全量计入 droppedBytes（文件不再增长）", async () => {
    const path = join(root, "cap-after.log");
    const sink = createLogSink(path, 4);
    sink.accept("abcd");
    sink.accept("more-bytes");
    await sink.close();
    expect(readFileSync(path, "utf8")).toBe("abcd");
    expect(sink.stats().droppedBytes).toBe("more-bytes".length);
  });

  it("帽落在多字节字符起始处回退到 0——如实截空 + truncated", async () => {
    const path = join(root, "cap-zero.log");
    const sink = createLogSink(path, 2);
    sink.accept("€x");
    await sink.close();
    expect(readFileSync(path, "utf8")).toBe("");
    expect(sink.stats().truncated).toBe(true);
    expect(sink.stats().droppedBytes).toBe(4);
  });
});

describe("createLogSink 写失败面", () => {
  it("日志路径是目录（EISDIR）→ writeError 标记 + 失败后到达计入 dropped + close 不挂", async () => {
    const dirPath = join(root, "as-dir");
    mkdirSync(dirPath);
    const sink = createLogSink(dirPath, 1_000);
    sink.accept("chunk-one");
    await sink.close();
    expect(sink.stats().writeError).toBeDefined();
    sink.accept("late-bytes");
    expect(sink.stats().droppedBytes).toBe("late-bytes".length);
  });

  it("回归：error 先于 close 发生（mid-run 写失败/open 失败的真实时序）→ close 必须返回不永挂", async () => {
    const dirPath = join(root, "as-dir-2");
    mkdirSync(dirPath);
    const sink = createLogSink(dirPath, 1_000);
    sink.accept("chunk");
    const deadline = Date.now() + 2_000;
    while (sink.stats().writeError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    expect(sink.stats().writeError).toBeDefined();
    const settled = await Promise.race([
      sink.close().then(() => "closed" as const),
      new Promise<"hang">((resolve) => { setTimeout(() => resolve("hang"), 1_500); }),
    ]);
    expect(settled).toBe("closed");
  });
});

describe("createLogSink 单写者保序", () => {
  it("双源交替提交：各源子序列保序 + 全量落盘不丢", async () => {
    const path = join(root, "interleave.log");
    const sink = createLogSink(path, 1 << 20);
    const a = Array.from({ length: 200 }, (_, i) => `A${String(i)};`);
    const b = Array.from({ length: 200 }, (_, i) => `B${String(i)};`);
    for (let i = 0; i < 200; i += 1) {
      sink.accept(a[i] as string);
      sink.accept(b[i] as string);
    }
    await sink.close();
    const text = readFileSync(path, "utf8");
    expect(text.match(/A\d+;/g)).toEqual(a);
    expect(text.match(/B\d+;/g)).toEqual(b);
    expect(text.length).toBe(a.join("").length + b.join("").length);
  });

  it("close 幂等（双 finalize 路径共用同一收尾）", async () => {
    const path = join(root, "idempotent.log");
    const sink = createLogSink(path, 1_000);
    sink.accept("once");
    await sink.close();
    await sink.close();
    expect(readFileSync(path, "utf8")).toBe("once");
  });
});

describe("pumpToSink", () => {
  it("跨 chunk UTF-8 撕裂不出替换符（单字节粒度泵送）", async () => {
    const path = join(root, "torn.log");
    const sink = createLogSink(path, 1_000);
    const full = "€α😀尾tail";
    const bytes = Buffer.from(full, "utf8");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    await pumpToSink(stream, sink);
    await sink.close();
    expect(readFileSync(path, "utf8")).toBe(full);
    expect(sink.stats().writtenBytes).toBe(Buffer.byteLength(full));
  });
});
