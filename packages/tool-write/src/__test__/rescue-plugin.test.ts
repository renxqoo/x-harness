// 抢救插件测试（docs/TRUNCATED-TOOL-RESCUE.md 层 2 测试口径）：真 waterfall 派发面
// （createContext + ctx.on 消费者 + dispatch）+ 真 PathGate/admitSession 授权面 +
// createLocalEnv 落盘断言。文案逐字断言（方案原文）；授权面攻击（越根/穿越/绝对路径）
// 与同名不覆盖、abort 竞态。

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolPayload } from "@x-harness/agent-loop";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createTruncatedWriteRescuePlugin } from "../rescue-plugin.ts";

let root = "";
let ctx: ReturnType<typeof createContext> | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-rescue-"));
});
afterEach(async () => {
  if (ctx !== undefined) await ctx.dispose().catch(() => {});
  ctx = undefined;
  rmSync(root, { recursive: true, force: true });
});

const SESSION = "sess-a" as never;
const LONG = "x".repeat(600); // 体积下限 512 之上
const SHORT = "x".repeat(511);

/** 真装配：插件挂进 context，经 ctx.dispatch(agentTruncatedTool) 走全链（含 next 链） */
async function dispatch(name: string, args: string, signal?: AbortSignal): Promise<{ readonly note: string } | undefined> {
  const c = createContext();
  ctx = c;
  const unload = await loadPlugins(c, [createTruncatedWriteRescuePlugin({ gate: new PathGate(root), observed: new ObservedRegistry(), env: createLocalEnv(root) })]);
  c.effect(() => { for (const off of unload) off(); });
  return c.dispatch(agentTruncatedTool, { session: SESSION, turn: 1, step: 1, callId: "c1", name, arguments: args, signal: signal ?? new AbortController().signal } as TruncatedToolPayload, async () => undefined);
}

/** dispatch 上游已应答形态（让位链验证：downstream 非空 → 透传不抢救） */
async function dispatchWithUpstream(name: string, args: string): Promise<{ readonly note: string } | undefined> {
  const c = createContext();
  ctx = c;
  const unload = await loadPlugins(c, [createTruncatedWriteRescuePlugin({ gate: new PathGate(root), observed: new ObservedRegistry(), env: createLocalEnv(root) })]);
  c.effect(() => { for (const off of unload) off(); });
  return c.dispatch(agentTruncatedTool, { session: SESSION, turn: 1, step: 1, callId: "c1", name, arguments: args, signal: new AbortController().signal } as TruncatedToolPayload, async () => ({ note: "upstream already handled" }));
}

describe("createTruncatedWriteRescuePlugin（write/edit 命中与让位）", () => {
  it("write 命中 content：物化 + write 文案逐字（chars/lines/path）", async () => {
    const body = ["alpha", "beta", "gamma"].join("\n").padEnd(600, "!");
    const r = await dispatch("write", `{"path":"out.ts","content":"${body}`);
    expect(r).toEqual({
      note: `Recovered ${String(body.length)} chars (${String(body.split("\n").length)} lines) of the truncated write to out.ts.partial (draft — out.ts NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.`,
    });
    expect(readFileSync(join(root, "out.ts.partial"), "utf8")).toBe(body);
    expect(existsSync(join(root, "out.ts"))).toBe(false); // 目标文件不动
  });

  it("edit 命中 new_string（含 edit 的工具名大小写不敏感）：物化 + edit 文案逐字", async () => {
    const r = await dispatch("FileEdit", `{"path":"src/a.ts","new_string":"${LONG}`);
    expect(r).toEqual({
      note: `Recovered ${String(LONG.length)} chars of the truncated edit's new_string to src/a.ts.partial (draft — src/a.ts NOT modified). Read it, re-issue the edit with the replacement text in smaller pieces, then delete the .partial.`,
    });
    expect(readFileSync(join(root, "src/a.ts.partial"), "utf8")).toBe(LONG);
  });

  it("其他工具名（bash）→ 让位（透传 next = undefined，不落盘）", async () => {
    const r = await dispatch("bash", `{"command":"echo ${LONG}"`);
    expect(r).toBeUndefined();
    expect(existsSync(join(root, "command.partial"))).toBe(false);
  });

  it("提取失败（无字段键）→ 让位", async () => {
    expect(await dispatch("write", '{"path":"a.ts","con')).toBeUndefined();
  });

  it("path 半截 → 让位（无法命名目标）", async () => {
    expect(await dispatch("write", `{"content":"${LONG}","path":"a.t`)).toBeUndefined();
  });

  it("体积下限（< 512 chars）→ 不物化但告知（N 占位实际数）", async () => {
    const r = await dispatch("write", `{"path":"small.txt","content":"${SHORT}`);
    expect(r).toEqual({ note: `truncated arguments too short to be worth a draft (${String(SHORT.length)} chars)` });
    expect(existsSync(join(root, "small.txt.partial"))).toBe(false);
  });

  it("上游中间件已应答 → 透传其 note（让位）", async () => {
    const r = await dispatchWithUpstream("write", `{"path":"up.txt","content":"${LONG}`);
    expect(r).toEqual({ note: "upstream already handled" });
    expect(existsSync(join(root, "up.txt.partial"))).toBe(false);
  });

  it("signal.aborted → 透传 next（abort 竞态不写盘）", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await dispatch("write", `{"path":"ab.txt","content":"${LONG}`, controller.signal);
    expect(r).toBeUndefined();
    expect(existsSync(join(root, "ab.txt.partial"))).toBe(false);
  });
});

describe("createTruncatedWriteRescuePlugin（授权面攻击——sidecar 与 write 同源过门）", () => {
  it("path=../outside.txt（穿越）→ 门拒 → 降级 note（不落盘）", async () => {
    const r = await dispatch("write", `{"path":"../outside.txt","content":"${LONG}`);
    expect(r).toEqual({ note: "target outside workspace boundary, draft not saved" });
    expect(existsSync(join(root, "..", "outside.txt.partial"))).toBe(false);
  });

  it("绝对路径越根（/tmp/xh-escape.txt）→ 门拒 → 降级 note（不落盘）", async () => {
    const r = await dispatch("write", `{"path":"/etc/xh-escape.txt","content":"${LONG}`);
    expect(r).toEqual({ note: "target outside workspace boundary, draft not saved" });
    expect(existsSync("/etc/xh-escape.txt.partial")).toBe(false);
  });

  it("workspace 内合法 → 物化成功（内容断言 = value）", async () => {
    const r = await dispatch("write", `{"path":"inner/deep/ok.txt","content":"${LONG}`);
    expect(r?.note).toContain("Recovered");
    expect(readFileSync(join(root, "inner/deep/ok.txt.partial"), "utf8")).toBe(LONG);
  });

  it("同名 .partial 已存在 → 拒绝覆盖（原内容不变）", async () => {
    writeFileSync(join(root, "keep.txt.partial"), "precious");
    const r = await dispatch("write", `{"path":"keep.txt","content":"${LONG}`);
    expect(r).toEqual({ note: "draft exists at keep.txt.partial, not overwritten" });
    expect(readFileSync(join(root, "keep.txt.partial"), "utf8")).toBe("precious");
  });
});

describe("createTruncatedWriteRescuePlugin（字节保真 round-trip）", () => {
  it("中文/转义字符：物化字节 = 解码后 value 的 utf8（round-trip）", async () => {
    // raw 是半截 JSON 原文（值内一切特殊字符以 JSON 转义形在场——提取器按转义规则解码）
    const decoded = `中文\n\t"quoted"\\slash😀\n${LONG}`;
    const encoded = JSON.stringify(decoded).slice(1, -1); // 同一字符串的 JSON 转义形（去外层引号）
    const r = await dispatch("write", `{"path":"zh.txt","content":"${encoded}`);
    expect(r?.note).toContain(`Recovered ${String(decoded.length)} chars`);
    expect(readFileSync(join(root, "zh.txt.partial"), "utf8")).toBe(decoded);
    expect(readFileSync(join(root, "zh.txt.partial"))).toEqual(Buffer.from(decoded, "utf8"));
  });
});
