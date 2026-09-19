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

async function makeRepl(scripts: LlmChunk[][], persist = false): Promise<ReplFixture> {
  const root = await mkdtemp(join(tmpdir(), "xh-repl-"));
  const stdin = new PassThrough();
  const output: string[] = [];
  const built = await buildWorld({
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
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
  const fixture: ReplFixture = {
    world: built.value,
    stdin,
    output,
    cleanup: async () => {
      await built.value.ctx.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
    waitFor,
  };
  fixtures.push(fixture);
  const replPromise = runRepl({
    world: built.value,
    handle: made.value,
    baseOptions: made.value.agent.options,
    args: argsOf([]),
    config: CONFIG.config,
    sessionRoot: join(root, "sessions"),
    persist,
    io: { write: (text) => output.push(text), stdin, isTTY: false },
  });
  void replPromise;
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
    await delay(100);
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
    await delay(100);
  });

  it("空行忽略不触发 turn；EOF（stdin end）退出", async () => {
    const fixture = await makeRepl([]);
    fixture.stdin.write("   \n");
    await delay(50);
    fixture.stdin.end();
    await delay(100);
    expect(fixture.output.join("")).not.toContain("turn 1");
  });
});
