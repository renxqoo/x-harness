// 共享测试世界（F1 kits + F3 testkit dogfood）：plugin-examples 全部用例的装置底座。

import type { Context } from "@x-harness/core";
import { textScript } from "@x-harness/testkit";
import { createLocalEnv } from "@x-harness/exec-env";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { inlineSessionKit, loopKit, meterKit, promptKit, toolboxKit } from "@x-harness/harness";
import type { World } from "@x-harness/harness";
import { llmKit } from "@x-harness/harness";
import type { Plugin } from "@x-harness/core";
import { createAgentWorld } from "@x-harness/harness";

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
  const root = await fsp.mkdtemp(`${os.tmpdir()}/xh-plx-`);
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

/** 跑一轮并取事件 */
export async function runTurn(tw: TestWorld, input: string): Promise<readonly { type: string; data: unknown }[]> {
  const made = await tw.world.loop.create({ agent: AGENT });
  if (!made.ok) throw new Error(made.reason);
  made.value.agent.followup(input);
  await made.value.agent.whenIdle();
  return made.value.agent.session.events() as readonly { type: string; data: unknown }[];
}

export const textsOf = (events: readonly { type: string; data: unknown }[], type: string): string[] =>
  events
    .filter((e) => e.type === type)
    .map((e) => ((e.data as { content?: readonly { type: string; text?: string }[] }).content ?? []).map((b) => (b as { text?: string }).text ?? "").join(""));
