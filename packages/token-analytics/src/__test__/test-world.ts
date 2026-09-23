// 包级测试装置：内存会话 + 假 llm（脚本驱动，可注入多适配器/窗口申报）+
// 挂被测插件（plugin-examples test-world 同构，testkit dogfood）。
import type { Context, Plugin } from "@x-harness/core";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { textScript } from "@x-harness/testkit";
import { createLocalEnv } from "@x-harness/exec-env";
import { createAgentWorld, durableSessionKit, inlineSessionKit, llmKit, loopKit, meterKit, promptKit, toolboxKit } from "@x-harness/harness";
import type { World } from "@x-harness/harness";

export interface TestWorld {
  readonly world: World;
  readonly ctx: Context;
  readonly calls: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk>>;
  readonly cleanup: () => Promise<void>;
}

/** 单适配器剧本流（缺省）：请求记账 + 按序消费剧本 */
function scriptAdapterFactory(calls: LlmRequest[], scripts: Array<AsyncGenerator<LlmChunk>>): LlmAdapter["stream"] {
  return (request: LlmRequest) => {
    calls.push(request);
    return scripts.shift() ?? textScript("(no script)");
  };
}

export interface TestWorldOptions {
  /** 覆盖适配器集（多适配器/窗口申报用例）；缺省单 "fake" 无窗口申报 */
  readonly adapters?: readonly LlmAdapter[];
  /** 持久会话根（在场 = durable 会话 kit——resume 两阶段用例）；缺省内存会话 */
  readonly durableRoot?: string;
}

/** 最小可跑世界：内存会话 + 全工具箱（local env）+ 假 llm + 挂被测插件 */
export async function makeTestWorld(plugins: readonly Plugin[] = [], options: TestWorldOptions = {}): Promise<TestWorld> {
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const root = await fsp.mkdtemp(`${os.tmpdir()}/xh-tka-`);
  const { PathGate } = await import("@x-harness/tool-core");
  const adapters =
    options.adapters ?? [{ name: "fake", stream: scriptAdapterFactory(calls, scripts) }];
  const sessionPlugins = options.durableRoot !== undefined ? durableSessionKit({ root: options.durableRoot }) : inlineSessionKit();
  const built = await createAgentWorld({
    plugins: [
      ...promptKit(),
      ...sessionPlugins,
      ...toolboxKit({ root, gate: new PathGate(root), env: createLocalEnv(root) }),
      ...meterKit(),
      ...llmKit([...adapters]),
      ...loopKit(),
      ...plugins,
    ],
  });
  if (!built.ok) throw new Error(built.reason);
  const world = built.value;
  return {
    world,
    ctx: world.ctx,
    calls,
    scripts,
    cleanup: async () => {
      await world.ctx.dispose();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

export const AGENT = { model: "fake-model", provider: "fake" } as const;
