// runPrintMode 进程内集成（docs/CLI.md §2.4）：真装配世界 + 剧本 adapter 驱动完整 turn。
// text 模式 stdout 纯最终文本/进度走 stderr；json 模式 JSONL 且 done 恰末行；错误退出码 1；
// 多消息顺序 turn；EPIPE 停写不崩。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { permissionDecided } from "@x-harness/permission";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseCliArgs } from "../parse-cli-args.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";
import { runPrintMode } from "../run-print-mode.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

function argsOf(argv: string[]) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

function scriptAdapter(scripts: LlmChunk[][], onStreamStart?: () => void): LlmAdapter {
  return {
    name: "glm",
    stream: (request: LlmRequest) => {
      void request;
      const next = scripts.shift();
      if (next === undefined) throw new Error("script exhausted");
      return (async function* (): AsyncGenerator<LlmChunk> {
        onStreamStart?.();
        for (const chunk of next) yield chunk;
      })();
    },
  };
}

function textScript(text: string): LlmChunk[] {
  return [
    { type: "text-delta", text },
    { type: "usage", usage: { input: 120, output: 40 } },
    { type: "finish", finish: { kind: "stop" } },
  ];
}

function errorScript(message: string): LlmChunk[] {
  return [{ type: "finish", finish: { kind: "error", message, code: "http-400" } }];
}

interface Harness {
  world: World;
  dispose: () => Promise<void>;
}

let harnesses: Harness[] = [];
beforeEach(() => {
  harnesses = [];
});
afterEach(async () => {
  for (const harness of harnesses) await harness.dispose().catch(() => {});
});

async function makeHarness(scripts: LlmChunk[][], over: { readonly onStreamStart?: () => void } = {}): Promise<{ harness: Harness; run: typeof runPrintMode }> {
  const root = await mkdtemp(join(tmpdir(), "xh-print-"));
  const built = await buildWorld({
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist: false,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    broker: createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) }),
    adapters: [scriptAdapter(scripts, over.onStreamStart)],
  });
  if (!built.ok) throw new Error(`buildWorld failed: ${built.reason}`);
  const harness: Harness = {
    world: built.value,
    dispose: async () => {
      await built.value.ctx.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
  harnesses.push(harness);
  return { harness, run: runPrintMode };
}

async function makeAgent(harness: Harness) {
  const made = await harness.world.loop.create({ session: { id: "print-test" as never }, agent: { model: "m1" } });
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

describe("runPrintMode text 模式", () => {
  it("stdout 仅最终文本；流式进度走 stderr", async () => {
    const { harness, run } = await makeHarness([textScript("FINAL")]);
    const handle = await makeAgent(harness);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p"]),
      initialMessage: "hi", remainingMessages: [],
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, progressTTY: false,
    });
    expect(code).toBe(0);
    expect(out).toEqual(["FINAL\n"]);
    expect(err.join("")).toContain("FINAL"); // 流式进度
  });

  it("多消息顺序执行多个 turn", async () => {
    const { harness, run } = await makeHarness([textScript("ONE"), textScript("TWO")]);
    const handle = await makeAgent(harness);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p"]),
      initialMessage: "q1", remainingMessages: ["q2"],
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, progressTTY: false,
    });
    expect(code).toBe(0);
    expect(out).toEqual(["TWO\n"]);
    expect(err.join("")).toContain("ONE");
  });

  it("LLM 错误 → exit 1，stderr 带 error，stdout 无文本", async () => {
    const { harness, run } = await makeHarness([errorScript("boom")]);
    const handle = await makeAgent(harness);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p"]),
      initialMessage: "hi", remainingMessages: [],
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, progressTTY: false,
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("error");
  });
});

describe("runPrintMode json 模式", () => {
  it("JSONL：session 首行、stream/tool/usage 中段、done 恰末行", async () => {
    const { harness, run } = await makeHarness([textScript("JSON")]);
    const handle = await makeAgent(harness);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p", "--mode", "json"]),
      initialMessage: "hi", remainingMessages: [],
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, progressTTY: false,
    });
    expect(code).toBe(0);
    const lines = out.join("").trim().split("\n").map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
    expect(lines[0]).toMatchObject({ type: "session", id: "print-test" });
    expect(lines.some((line) => line.type === "stream" && line.kind === "text")).toBe(true);
    expect(lines.some((line) => line.type === "usage")).toBe(true);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({ type: "done", exit: 0 });
  });

  it("permission 事件行：审批裁决审计事件在订阅期内派发 → JSONL 含 permission 行", async () => {
    // onStreamStart 在 turn 内（订阅存活期）派发 permissionDecided——permission 插件
    // 真实裁决路径 emit 的同一 token/payload 形态
    const events: { tool: string; verdict: string; reason: string }[] = [];
    const { harness, run } = await makeHarness([textScript("P")], {
      onStreamStart: () => {
        for (const event of events) harness.world.ctx.emit(permissionDecided, event);
      },
    });
    events.push({ tool: "bash", verdict: "deny", reason: "outside root" });
    const handle = await makeAgent(harness);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p", "--mode", "json"]),
      initialMessage: "hi", remainingMessages: [],
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, progressTTY: false,
    });
    expect(code).toBe(0);
    const lines = out.join("").trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string; verdict?: string });
    const permission = lines.find((line) => line.type === "permission");
    expect(permission).toMatchObject({ tool: "bash", verdict: "deny" });
  });

  it("EPIPE：首写即断管 → 停写、exit 1、不崩", async () => {
    const { harness, run } = await makeHarness([textScript("PIPE")]);
    const handle = await makeAgent(harness);
    const err: string[] = [];
    let writes = 0;
    const code = await run({
      ctx: harness.world.ctx, handle, meter: harness.world.meter, args: argsOf(["-p", "--mode", "json"]),
      initialMessage: "hi", remainingMessages: [],
      streams: {
        out: () => {
          writes += 1;
          throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        },
        err: (t) => err.push(t),
      }, progressTTY: false,
    });
    expect(code).toBe(1);
    expect(writes).toBe(1); // 断后不再写
  });
});
