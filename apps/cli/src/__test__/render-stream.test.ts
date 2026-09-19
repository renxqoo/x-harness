// 流式渲染（docs/CLI.md §2.3）：帧序列 → 期望输出（sink 收集断言）。text/thinking 交错换行、
// attempt 边界、工具行 pair、TTY dim 开关、参数/错误截断。

import { describe, expect, it } from "vitest";
import { createStreamRenderer } from "../render-stream.ts";
import type { SessionEvent, SessionEventType } from "@x-harness/session";

function toolCall(name: string, args: string, callId = "c1"): SessionEvent<SessionEventType> {
  return { type: "tool/call", seq: 1, time: 0, data: { turn: 1, step: 1, callId, name, arguments: args } } as SessionEvent<SessionEventType>;
}

/** tool/result 事件不带工具名：渲染器从 callId 映射（name 参数仅用于命名 callId 的可读性） */
function toolResult(callId: string, content: string, isError: boolean): SessionEvent<SessionEventType> {
  return { type: "tool/result", seq: 2, time: 0, data: { turn: 1, step: 1, callId, content, ...(isError ? { isError: true } : {}) } } as SessionEvent<SessionEventType>;
}

function render(tty: boolean): { lines: string[]; renderer: ReturnType<typeof createStreamRenderer> } {
  const chunks: string[] = [];
  const renderer = createStreamRenderer({ write: (text) => chunks.push(text), isTTY: tty });
  return { lines: chunks, renderer };
}

describe("createStreamRenderer 流帧", () => {
  it("text 帧原色直通；thinking 帧 TTY 下 dim、管道下纯文本", () => {
    const tty = render(true);
    tty.renderer.frame({ phase: "chunk", kind: "text", text: "hello" });
    tty.renderer.frame({ phase: "chunk", kind: "thinking", text: "hm" });
    expect(tty.lines).toEqual(["hello", "\n", "\x1b[2mhm\x1b[0m"]);

    const pipe = render(false);
    pipe.renderer.frame({ phase: "chunk", kind: "text", text: "hello" });
    pipe.renderer.frame({ phase: "chunk", kind: "thinking", text: "hm" });
    expect(pipe.lines).toEqual(["hello", "\n", "hm"]);
  });

  it("同 kind 连续不换行；kind 切换恰一次换行", () => {
    const { lines, renderer } = render(false);
    renderer.frame({ phase: "chunk", kind: "text", text: "a" });
    renderer.frame({ phase: "chunk", kind: "text", text: "b" });
    renderer.frame({ phase: "chunk", kind: "thinking", text: "t" });
    renderer.frame({ phase: "chunk", kind: "thinking", text: "t2" });
    expect(lines).toEqual(["a", "b", "\n", "t", "t2"]);
  });

  it("end(message) 收尾换行；attempt 边界双换行分隔；start 复位", () => {
    const { lines, renderer } = render(false);
    renderer.frame({ phase: "chunk", kind: "text", text: "x" });
    renderer.frame({ phase: "end", kind: "attempt" });
    renderer.frame({ phase: "start" });
    renderer.frame({ phase: "chunk", kind: "text", text: "y" });
    renderer.frame({ phase: "end", kind: "message" });
    expect(lines).toEqual(["x", "\n", "\n", "y", "\n"]);
  });

  it("流中无内容时 end 不产生空行", () => {
    const { lines, renderer } = render(false);
    renderer.frame({ phase: "start" });
    renderer.frame({ phase: "end", kind: "message" });
    expect(lines).toEqual([]);
  });
});

describe("createStreamRenderer 工具行", () => {
  it("call → `→ name 首行参数`；result → `✓`/`✗ + 错误首行`；流未收尾时先换行", () => {
    const { lines, renderer } = render(false);
    renderer.frame({ phase: "chunk", kind: "text", text: "partial" });
    renderer.sessionEvent(toolCall("bash", '{"command":"git status"}'));
    renderer.sessionEvent(toolResult("c1", "ok", false));
    renderer.sessionEvent(toolResult("c1", "boom\nsecond", true));
    expect(lines).toEqual([
      "partial", "\n",
      "→ bash {\"command\":\"git status\"}\n",
      "✓ bash\n",
      "✗ bash boom\n",
    ]);
  });

  it("超长参数/错误截断到 80 字符 + 省略号", () => {
    const { lines, renderer } = render(false);
    const long = "x".repeat(200);
    renderer.sessionEvent(toolCall("write", long));
    expect(lines[0]).toBe(`→ write ${"x".repeat(80)}…\n`);
  });
});
