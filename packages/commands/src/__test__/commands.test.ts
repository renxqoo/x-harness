// 命令注册面单元（BATCH3-DESIGN §2.1/§2.2）：词法表驱动、注册校验 fail-fast、
// execute 三态（undefined/结果/重抛）、run|done 配对落账、commandsChange 通知、
// gates 配对校验全卷回归。
import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin, sessionStore, validateSessionEvents } from "@x-harness/session";
import type { Session } from "@x-harness/session";
import { commandsPlugin } from "../plugin.ts";
import { parseCommand } from "../lexer.ts";
import { commandRegistry, commandsChange } from "../tokens.ts";

async function makeSession(): Promise<{ session: Session; cleanup: () => Promise<void> }> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, commandsPlugin]);
  const store = ctx.use(sessionStore);
  const made = await store.create();
  if (!made.ok) throw new Error(made.reason);
  return {
    session: made.value,
    cleanup: async () => {
      await ctx.dispose();
      void unload;
    },
  };
}

describe("parseCommand 词法（BATCH3-DESIGN §2.1——trim 保留 + 小写开头 + verbatim args）", () => {
  it.each([
    ["/compact", { name: "compact", rawInput: "" }],
    ["/compact keep goals", { name: "compact", rawInput: " keep goals" }], // 分隔空白属 rawInput（逐字）
    ["  /compact  spaced  ", { name: "compact", rawInput: "  spaced" }], // 前导/尾随 trim；名字后原文逐字（含分隔空白）
    ["/a-b_c9", { name: "a-b_c9", rawInput: "" }],
  ])("%j → %j", (line, expected) => {
    expect(parseCommand(line)).toEqual(expected);
  });

  it.each(["//comment", "/Compact", "/9x", "plain text", "compact"])("%j 不命中（undefined）", (line) => {
    expect(parseCommand(line)).toBeUndefined();
  });
});

describe("commandRegistry 注册面", () => {
  it("注册/注销 + 目录 name 序 + 同名/违词形/空描述 fail-fast", async () => {
    const made = await makeSession();
    try {
      const ctx = (made.session as unknown as { __ctx?: never }) && null;
      void ctx;
      // 经插件装配的服务消费：重新建一个带 use 面的 ctx（registry 在 plugin 内 provide）
      const registry = await registryOf();
      const handler = () => ({ kind: "success" as const });
      registry.register({ name: "zeta", description: "z", execute: handler });
      const off = registry.register({ name: "alpha", description: "a", execute: handler });
      expect(registry.list().map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
      expect(registry.find("alpha")?.description).toBe("a");
      off();
      expect(registry.find("alpha")).toBeUndefined();
      expect(() => registry.register({ name: "zeta", description: "z", execute: handler })).toThrow(/already registered/);
      expect(() => registry.register({ name: "Bad", description: "x", execute: handler })).toThrow(/must match/);
      expect(() => registry.register({ name: "ok", description: "  ", execute: handler })).toThrow(/non-empty/);
      expect(() => registry.register({ name: "ok2", description: "x", execute: undefined as never })).toThrow(/function/);
    } finally {
      await made.cleanup();
    }
  });

  it("commandsChange 在增删时发射（非否决）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [sessionPlugin, commandsPlugin]);
    const registry = ctx.use(commandRegistry);
    let changes = 0;
    ctx.on(commandsChange, () => {
      changes += 1;
    });
    const off = registry.register({ name: "ping", description: "p", execute: () => ({ kind: "success" }) });
    off();
    expect(changes).toBe(2);
    await ctx.dispose();
    void unload;
  });
});

describe("execute 三态与配对落账", () => {
  it("未命中（词法/未注册）→ undefined，零事件", async () => {
    const made = await makeSession();
    try {
      const registry = await registryOf();
      const miss = await registry.execute(made.session, "plain", new AbortController().signal);
      expect(miss).toBeUndefined();
      const unregistered = await registry.execute(made.session, "/nope args", new AbortController().signal);
      expect(unregistered).toBeUndefined();
      expect(made.session.events().filter((e) => e.type.startsWith("command/"))).toEqual([]);
    } finally {
      await made.cleanup();
    }
  });

  it("已中止 signal → throw 零事件", async () => {
    const made = await makeSession();
    try {
      const registry = await registryOf();
      registry.register({ name: "ping", description: "p", execute: () => ({ kind: "success" }) });
      const controller = new AbortController();
      controller.abort();
      await expect(registry.execute(made.session, "/ping", controller.signal)).rejects.toThrow();
      expect(made.session.events().filter((e) => e.type.startsWith("command/"))).toEqual([]);
    } finally {
      await made.cleanup();
    }
  });

  it("成功/期望失败：run→handler→done 配对落账（log-only 不进 surface）；recordInput:false 省args", async () => {
    const made = await makeSession();
    try {
      const registry = await registryOf();
      registry.register({
        name: "dump",
        description: "d",
        execute: ({ rawInput }) => ({ kind: "success", text: `did ${rawInput.trim()}`, data: { replacedCount: 3 } }),
      });
      registry.register({ name: "quiet", description: "q", recordInput: false, execute: () => ({ kind: "success" }) });
      registry.register({ name: "failing", description: "f", execute: () => ({ kind: "error", text: "expected failure" }) });
      const ok = await registry.execute(made.session, "/dump keep", new AbortController().signal);
      expect(ok?.result).toEqual({ kind: "success", text: "did keep", data: { replacedCount: 3 } });
      const quiet = await registry.execute(made.session, "/quiet secret", new AbortController().signal);
      expect(quiet?.result).toEqual({ kind: "success" });
      const failed = await registry.execute(made.session, "/failing", new AbortController().signal);
      expect(failed?.result).toEqual({ kind: "error", text: "expected failure" });
      const events = made.session.events().filter((e) => e.type.startsWith("command/"));
      const runIds = events.filter((e) => e.type === "command/run").map((e) => (e as { data: { commandId: string } }).data.commandId);
      expect(new Set(runIds).size).toBe(3); // commandId 唯一
      const quietRun = events.find((e) => e.type === "command/run" && (e as { data: { name: string } }).data.name === "quiet");
      expect((quietRun as { data: Record<string, unknown> }).data).not.toHaveProperty("args"); // recordInput:false
      const dumpRun = events.find((e) => e.type === "command/run" && (e as { data: { name: string } }).data.name === "dump");
      expect((dumpRun as { data: { args: string } }).data.args).toBe(" keep"); // 逐字（含分隔空白）
      expect(made.session.surface()).toEqual([]); // log-only 不进模型上下文
    } finally {
      await made.cleanup();
    }
  });

  it("handler throw：落 done{error} 后重抛（调用方感知）", async () => {
    const made = await makeSession();
    try {
      const registry = await registryOf();
      registry.register({
        name: "buggy",
        description: "b",
        execute: () => {
          throw new Error("handler bug");
        },
      });
      await expect(registry.execute(made.session, "/buggy", new AbortController().signal)).rejects.toThrow("handler bug");
      const events = made.session.events().filter((e) => e.type.startsWith("command/"));
      expect(events).toHaveLength(2);
      expect((events[1] as { data: { kind: string; text: string } }).data).toEqual({ commandId: (events[0] as { data: { commandId: string } }).data.commandId, kind: "error", text: "command handler failed" });
    } finally {
      await made.cleanup();
    }
  });

  it("结果形状违约：registry 边界 throw", async () => {
    const made = await makeSession();
    try {
      const registry = await registryOf();
      registry.register({ name: "badresult", description: "b", execute: () => "nope" as never });
      await expect(registry.execute(made.session, "/badresult", new AbortController().signal)).rejects.toThrow(/must return a CommandResult/);
    } finally {
      await made.cleanup();
    }
  });
});

describe("gates 配对校验全卷（at-most-once 双向；悬挂 run 合法）", () => {
  const run = (seq: number, commandId: string): Record<string, unknown> => ({ type: "command/run", seq, time: 1, data: { commandId, name: "x" } });
  const done = (seq: number, commandId: string): Record<string, unknown> => ({ type: "command/done", seq, time: 1, data: { commandId, kind: "success" } });

  it("正常配对/悬挂 run 通过；done 无 run、重复 run、重复 done 拒", () => {
    expect(validateSessionEvents([run(0, "c1"), done(1, "c1"), run(2, "c2")])).toBeUndefined(); // 悬挂 run 合法
    expect(validateSessionEvents([done(0, "c1")])).toMatch(/command-done-unpaired/);
    expect(validateSessionEvents([run(0, "c1"), run(1, "c1")])).toMatch(/command-run-duplicate/);
    expect(validateSessionEvents([run(0, "c1"), done(1, "c1"), done(2, "c1")])).toMatch(/command-done-unpaired/); // 第二个 done 消费后仍须有未配对 run
    expect(validateSessionEvents([{ type: "command/run", seq: 0, time: 1, data: { commandId: "", name: "x" } }])).toMatch(/shape:command\/run/); // 形状门
  });
});

/** 独立 registry 装置（与 makeSession 分离——registry 无会话态） */
async function registryOf() {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [commandsPlugin]);
  void unload;
  return ctx.use(commandRegistry);
}
