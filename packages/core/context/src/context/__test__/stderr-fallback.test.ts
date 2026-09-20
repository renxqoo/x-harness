
// 内核统一留痕通道的回归用例：症状 = 旧实现直连 process.stderr，浏览器（无 process
// 全局）下三处触发点抛 ReferenceError。回归面：defaultSink / softInject 近距警告 /
// 装配失败回卷兜底，各自验证「无 process 宿主下留痕可达不炸 + 消息完整」+ 通道函数本体。
import { describe, expect, it, vi } from "vitest";
import { createContext } from "../create-context.ts";
import { loadPlugins } from "../load-plugins.ts";
import { defineEvent } from "../tokens.ts";
import type { Plugin } from "../types.ts";
import { stderrLine } from "../../stderr-line.ts";

/** 模拟浏览器宿主：摘掉 process 全局，结束后恢复（断言放窗外，留痕窗口内不给 runner 触 process 的机会） */
async function withoutProcess(run: () => Promise<void>): Promise<void> {
  const host = globalThis as { process?: unknown };
  const original = host.process;
  host.process = undefined;
  try {
    await run();
  } finally {
    host.process = original;
  }
}

/** 具名抛错监听器/清理器：避免 describe → it → withoutProcess → 箭头回调四层嵌套 */
function throwFromListener(): void {
  throw new Error("listener炸了");
}

function throwFromDispose(): void {
  throw new Error("dispose也炸了");
}

describe("stderrLine 宿主无关留痕", () => {
  it("回归：无 process 时 defaultSink 不抛 ReferenceError，降级 console.error 且消息完整", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await withoutProcess(async () => {
        const ctx = createContext(); // 不注入 onListenerError → 走 defaultSink
        const boom = defineEvent("boom");
        ctx.on(boom, throwFromListener);
        ctx.emit(boom, {});
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[x-harness] listener error on "boom"');
    expect(errors[0]).toContain("listener炸了");
  });

  it("回归：无 process 时 softInject 拼写近距警告降级 console.error，装配不受影响", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await withoutProcess(async () => {
        const ctx = createContext();
        const logger: Plugin = { name: "logger", apply: () => {} };
        const dependent: Plugin = { name: "feature", softInject: ["loger"], apply: () => {} };
        await loadPlugins(ctx, [dependent, logger]);
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[softInject] plugin "feature" declares "loger" — did you mean "logger"?');
  });

  it("回归：无 process 时装配失败 + dispose 也失败的兜底留痕降级 console.error，根因仍上抛", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await withoutProcess(async () => {
        const ctx = createContext();
        ctx.effect(throwFromDispose);
        const failing: Plugin = {
          name: "p",
          apply: () => {
            throw new Error("apply炸了");
          },
        };
        await expect(loadPlugins(ctx, [failing])).rejects.toThrow("apply炸了");
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[x-harness] dispose during plugin load failure also failed");
    expect(errors[0]).toContain("dispose也炸了");
  });

  it("回归：宿主覆写 console.error 抛错时留痕静默不外抛（症状：兜底留痕吞 apply 根因）", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        throw new Error("console被覆写");
      });
    try {
      expect(() => stderrLine("any message")).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("通道函数本体：console.error 单参透传（Node 下即 stderr）", () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      stderrLine("kernel line");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors).toEqual(["kernel line"]);
  });
});
