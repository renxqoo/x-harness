// 帧分类与命令词表契约：responseLine/classifyResponseHead key 顺序与转义边界、
// 协议词表封闭性（COMMAND_NAMES 与四集合包含关系）。
import { describe, expect, test } from "vitest";
import { classifyResponseHead, responseLine } from "../shared/frame-classify.ts";
import { COMMAND_NAMES } from "../protocol/commands.ts";
import { DRIVING_COMMANDS, HOST_RELAYED_THREAD_COMMANDS, OBSERVER_COMMANDS, THREAD_SCOPED_COMMANDS } from "../protocol/internal.ts";

describe("frame-classify（key 顺序契约）", () => {
  test("字面量 → 正则往返：带 id（success 提取——受理对账面）", () => {
    const line = responseLine({ id: "42", command: "prompt", success: true });
    const c = classifyResponseHead(line);
    expect(c).toEqual({ kind: "response", id: "42", command: "prompt", success: true });
    const failLine = responseLine({ id: "43", command: "prompt", success: false, error: "inbox full" });
    expect(classifyResponseHead(failLine)).toEqual({ kind: "response", id: "43", command: "prompt", success: false });
  });

  test("无 id 响应（parse failure 形态）", () => {
    const line = responseLine({ command: "parse", success: false, error: "bad" });
    expect(classifyResponseHead(line)?.id).toBeUndefined();
    expect(classifyResponseHead(line)?.command).toBe("parse");
  });

  test("id 含转义字符不误导分类", () => {
    const line = responseLine({ id: 'a"b\\c', command: "bash", success: true, data: { x: 1 } });
    expect(classifyResponseHead(line)?.id).toBe('a"b\\c');
  });

  test("非 response 帧头不识别（event/heartbeat）", () => {
    expect(classifyResponseHead('{"type":"event","threadId":"t1"}')).toBeUndefined();
    expect(classifyResponseHead('{"type":"heartbeat"}')).toBeUndefined();
  });

  test("data/error 互斥形状", () => {
    expect(responseLine({ command: "c", success: true })).toBe('{"id":null,"type":"response","command":"c","success":true}');
    expect(responseLine({ command: "c", success: false, error: "e" })).toContain('"error":"e"');
    expect(responseLine({ command: "c", success: true, data: [1] })).toContain('"data":[1]');
  });
});

describe("协议词表封闭性", () => {
  test("55 命令；四集合成员都在命令表内", () => {
    expect(COMMAND_NAMES.length).toBe(56);
    expect(new Set(COMMAND_NAMES).size).toBe(56);
    for (const set of [THREAD_SCOPED_COMMANDS, OBSERVER_COMMANDS, DRIVING_COMMANDS, HOST_RELAYED_THREAD_COMMANDS]) {
      for (const name of set) expect(COMMAND_NAMES.includes(name)).toBe(true);
    }
  });

  test("驱动 ⊂ 线程域；观察者 ⊂ 线程域 ∪ 转发白名单；转发白名单 ∩ 线程域 = 空", () => {
    for (const n of DRIVING_COMMANDS) expect(THREAD_SCOPED_COMMANDS.has(n)).toBe(true);
    for (const n of OBSERVER_COMMANDS) expect(THREAD_SCOPED_COMMANDS.has(n) || HOST_RELAYED_THREAD_COMMANDS.has(n)).toBe(true);
    for (const n of HOST_RELAYED_THREAD_COMMANDS) expect(THREAD_SCOPED_COMMANDS.has(n)).toBe(false);
  });
});
