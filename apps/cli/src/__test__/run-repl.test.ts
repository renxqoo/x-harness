// REPL 驱动（docs/CLI.md §2.3）：进程内以 PassThrough stdin 驱动完整 runRepl——
// banner/流式输出/用量行/steer busy 提示/slash 分派//quit 退出码；行分派纯函数表驱动。
// 退出经 /quit（管道下 Ctrl+C 不可注入——信号面由 e2e 覆盖）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseCliArgs } from "../parse-cli-args.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";
import { decideLineAction, runRepl } from "../run-repl.ts";

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

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("decideLineAction（表驱动）", () => {
  const cases: readonly { readonly name: string; readonly line: string; readonly running: boolean; readonly expected: { kind: string; text?: string } }[] = [
    { name: "空行/纯空白忽略", line: "   ", running: false, expected: { kind: "ignore" } },
    { name: "slash 行透传（idle）", line: "/help", running: false, expected: { kind: "slash" } },
    { name: "slash 行透传（running）", line: "/model", running: true, expected: { kind: "slash" } },
    { name: "running → steer", line: "more input", running: true, expected: { kind: "steer", text: "more input" } },
    { name: "idle → followup", line: "hello", running: false, expected: { kind: "followup", text: "hello" } },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const action = decideLineAction(testCase.line, testCase.running);
      expect(action.kind).toBe(testCase.expected.kind);
      if (action.kind === "steer" || action.kind === "followup") expect(action.text).toBe(testCase.expected.text);
    });
  }
});

interface ReplFixture {
  world: World;
  stdin: PassThrough;
  output: string[];
  /** REPL 主 promise：/quit/EOF/信号后 await 并断言退出码（挂起即用例超时暴露） */
  exitCode: () => Promise<number>;
  /** 触发已注册的信号回调（REPL 经 onSignal 登记的面） */
  signal: (kind: "SIGINT" | "SIGTERM" | "SIGHUP") => void;
  cleanup: () => Promise<void>;
  waitFor: (marker: string) => Promise<void>;
}

const fixtures: ReplFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures) await fixture.cleanup().catch(() => {});
});

function scriptAdapter(scripts: LlmChunk[][]): LlmAdapter {
  return {
    name: "glm",
    stream: (request: LlmRequest) => {
      void request;
      const next = scripts.shift();
      if (next === undefined) throw new Error("script exhausted");
      return (async function* (): AsyncGenerator<LlmChunk> {
        for (const chunk of next) yield chunk;
      })();
    },
  };
}

const textScript = (text: string): LlmChunk[] => [
  { type: "text-delta", text },
  { type: "usage", usage: { input: 12, output: 6 } },
  { type: "finish", finish: { kind: "stop" } },
];

async function makeRepl(scripts: LlmChunk[][], over: { persist?: boolean; permission?: "plan" | "auto" | "full" } = {}): Promise<ReplFixture> {
  const persist = over.persist ?? false;
  const root = await mkdtemp(join(tmpdir(), "xh-repl-"));
  const stdin = new PassThrough();
  const output: string[] = [];
  const signalCbs: Partial<Record<"SIGINT" | "SIGTERM" | "SIGHUP", () => void>> = {};
  const built = await buildWorld({
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    ...(over.permission !== undefined ? { permission: over.permission } : {}),
    broker: createTerminalBrokerPlugin({ interactive: true, write: () => {}, question: () => Promise.resolve(undefined) }),
    adapters: [scriptAdapter(scripts)],
  });
  if (!built.ok) throw new Error(built.reason);
  const made = await built.value.loop.create({ session: { id: "repl-test" as never }, agent: { model: "m1" } });
  if (!made.ok) throw new Error(made.reason);
  const waitFor = async (marker: string): Promise<void> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (output.join("").includes(marker)) return;
      if (Date.now() > deadline) throw new Error(`waitFor timeout: ${marker}`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  };
  const replPromise = runRepl({
    world: built.value,
    handle: made.value,
    baseOptions: made.value.agent.options,
    args: argsOf([]),
    config: CONFIG.config,
    sessionRoot: join(root, "sessions"),
    persist,
    io: { write: (text) => output.push(text), stdin, isTTY: false, onSignal: (kind, callback) => { signalCbs[kind] = callback; } },
  });
  const fixture: ReplFixture = {
    world: built.value,
    stdin,
    output,
    exitCode: () => replPromise,
    signal: (kind) => signalCbs[kind]?.(),
    cleanup: async () => {
      await built.value.ctx.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
    waitFor,
  };
  fixtures.push(fixture);
  await waitFor("type /help");
  return fixture;
}

describe("runRepl（管道驱动）", () => {
  it("一轮对话：banner + 流式正文 + 用量行 + prompt；/quit 退出码 0", async () => {
    const fixture = await makeRepl([textScript("REPL-ANSWER")]);
    fixture.stdin.write("hello\n");
    await fixture.waitFor("REPL-ANSWER");
    await fixture.waitFor("turn 1");
    fixture.stdin.write("/quit\n");
    expect(await fixture.exitCode()).toBe(0);
    const text = fixture.output.join("");
    expect(text).toContain("x-harness v");
    expect(text).toContain("session repl-test");
  });

  it("slash：/session 显示 facts 与用量；未知命令提示", async () => {
    const fixture = await makeRepl([textScript("OK1")]);
    fixture.stdin.write("/session\n");
    await fixture.waitFor("tokens:");
    fixture.stdin.write("/nope\n");
    await fixture.waitFor("unknown command");
    fixture.stdin.write("/quit\n");
    expect(await fixture.exitCode()).toBe(0);
  });

  it("空行忽略不触发 turn；EOF（stdin end）退出码 0", async () => {
    const fixture = await makeRepl([]);
    fixture.stdin.write("   \n");
    await delay(50);
    fixture.stdin.end();
    expect(await fixture.exitCode()).toBe(0);
    expect(fixture.output.join("")).not.toContain("turn 1");
  });

  it("SIGTERM：退出码 143 且清理路径可达（回归：退出不 cancel 在飞 turn 会挂死）", async () => {
    const fixture = await makeRepl([textScript("SLOW")]);
    fixture.stdin.write("hello\n");
    await fixture.waitFor("SLOW");
    fixture.signal("SIGTERM");
    expect(await fixture.exitCode()).toBe(143);
  });

  it("persist=true：/thinking 切换走 dispose→resume 续写（事件卷跨代延续）", async () => {
    const fixture = await makeRepl([textScript("FIRST"), textScript("SECOND")], { persist: true });
    fixture.stdin.write("hi\n");
    await fixture.waitFor("FIRST");
    await fixture.waitFor("turn 1");
    fixture.stdin.write("/thinking low\n");
    await fixture.waitFor("switched to");
    fixture.stdin.write("again\n");
    await fixture.waitFor("SECOND");
    fixture.stdin.write("/quit\n");
    expect(await fixture.exitCode()).toBe(0);
    const text = fixture.output.join("");
    expect(text).toContain("note: switching resets"); // 副作用提示
  });
});

describe("runRepl × 工具 flag（W2B 挂账收口——makeNext 重演矩阵）", () => {
  it("/new：新会话继承 --tools 白名单（restriction 重演，工具面不放宽）", async () => {
    const repl = await makeRepl([textScript("REPL-ANSWER")]);
    repl.stdin.write("hi\n");
    await repl.waitFor("REPL-ANSWER");
    repl.stdin.write("/new\n");
    await repl.waitFor("new session ");
    const out = repl.output.join("");
    const newId = out.slice(out.lastIndexOf("new session ") + "new session ".length).split(" ")[0];
    const restriction = repl.world.registry.restrictionOf(newId as never);
    expect(restriction).toBeDefined(); // create 语义：恒注册（全量快照——无 flag 时）
    repl.stdin.write("/quit\n");
    await repl.exitCode();
    await repl.cleanup();
  });

  it("--tools read 下 /new 与 /model：restriction 精确重演为白名单（不静默放宽）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-repl-tools-"));
    const stdin = new PassThrough();
    const output: string[] = [];
    const built = await buildWorld({
      cwd: root,
      sessionRoot: join(root, "sessions"),
      persist: true,
      config: CONFIG.config,
      resolution: CONFIG.resolution,
      broker: createTerminalBrokerPlugin({ interactive: true, write: () => {}, question: () => Promise.resolve(undefined) }),
      adapters: [scriptAdapter([textScript("REPL-ANSWER"), textScript("M2"), textScript("M3")])],
    });
    if (!built.ok) throw new Error(built.reason);
    const made = await built.value.loop.create({ session: { id: "repl-tools" as never }, agent: { model: "m1" } });
    if (!made.ok) throw new Error(made.reason);
    built.value.registry.scoped(made.value.agent.session.id).restrict(["read"]); // 模拟 main.openWorld 的初始注册（create 恒注册）
    const replPromise = runRepl({
      world: built.value,
      handle: made.value,
      baseOptions: made.value.agent.options,
      args: argsOf(["--tools", "read"]),
      config: CONFIG.config,
      sessionRoot: join(root, "sessions"),
      persist: true,
      io: { write: (text: string) => output.push(text), stdin, isTTY: false, onSignal: () => {} },
    });
    const waitFor = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        if (output.join("").includes(marker)) return;
        if (Date.now() > deadline) throw new Error(`timeout: ${marker}`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    };
    await waitFor("type /help");
    replPromise.catch(() => {}); // 静默收割退出
    // /model：dispose→同 id resume → 重注册（F-2 场景 5）
    stdin.write("/model m1\n");
    await waitFor("switched to");
    expect(built.value.registry.restrictionOf(made.value.agent.session.id)).toEqual(["read"]); // 同 id 重演
    // /new：新 id → create 语义注册白名单
    stdin.write("/new\n");
    await waitFor("new session ");
    const out = output.join("");
    const newId = out.slice(out.lastIndexOf("new session ") + "new session ".length).split(" ")[0];
    expect(built.value.registry.restrictionOf(newId as never)).toEqual(["read"]); // 不放宽
    stdin.write("/quit\n");
    await replPromise;
    await built.value.ctx.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
});

describe("runRepl × --permission（reopen 保持矩阵——docs/PERMISSION-MODE-FLAG.md）", () => {
  it("/new：新会话仍按 plan 裁决 write 拒（mode 经 plugin apply 闭包保持，会话重建不丢）", async () => {
    const repl = await makeRepl([textScript("REPL-ANSWER")], { permission: "plan" });
    repl.stdin.write("/new\n");
    await repl.waitFor("new session ");
    const out = repl.output.join("");
    const newId = out.slice(out.lastIndexOf("new session ") + "new session ".length).split(" ")[0];
    expect(repl.world.registry.restrictionOf(newId as never)).toBeDefined(); // 提取自检（W2B 同款）：垃圾 id 静默错在此先红
    const outcome = await repl.world.registry.dispatch({
      callId: "perm-reopen-1",
      name: "write",
      args: { path: "escape.txt", content: "x" },
      signal: new AbortController().signal,
      session: newId as never,
    });
    expect(outcome).toMatchObject({ isError: true, content: expect.stringContaining("plan mode disallows write") });
    repl.stdin.write("/quit\n");
    await repl.exitCode();
    await repl.cleanup();
  });
});
