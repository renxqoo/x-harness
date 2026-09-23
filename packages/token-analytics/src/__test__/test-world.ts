// 包级测试装置：内存会话 + 假 llm（脚本驱动）+ 挂被测插件（plugin-examples
// test-world 同构，testkit dogfood）。
import type { Context, Plugin } from "@x-harness/core";
import { textScript } from "@x-harness/testkit";
import { createLocalEnv } from "@x-harness/exec-env";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { createAgentWorld, inlineSessionKit, llmKit, loopKit, meterKit, promptKit, toolboxKit } from "@x-harness/harness";
import type { World } from "@x-harness/harness";

export interface TestWorld {
  readonly world: World;
  readonly ctx: Context;
  readonly calls: LlmRequest[];
  readonly scripts: Array<AsyncGenerator<LlmChunk>>;
  readonly cleanup: () => Promise<void>;
}

/** 最小可跑世界：内存会话 + 全工具箱（local env）+ 假 llm + 挂被测插件 */
export async function makeTestWorld(plugins: readonly Plugin[] = []): Promise<TestWorld> {
  const calls: LlmRequest[] = [];
  const scripts: Array<AsyncGenerator<LlmChunk>> = [];
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const root = await fsp.mkdtemp(`${os.tmpdir()}/xh-tka-`);
  const { PathGate } = await import("@x-harness/tool-core");
  const built = await createAgentWorld({
    plugins: [
      ...promptKit(),
      ...inlineSessionKit(),
      ...toolboxKit({ root, gate: new PathGate(root), env: createLocalEnv(root) }),
      ...meterKit(),
      ...llmKit([{ name: "fake", stream: (request) => { calls.push(request); return scripts.shift() ?? textScript("(no script)"); } }]),
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
