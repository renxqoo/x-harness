import { join } from "node:path";
import type { Plugin } from "@x-harness/core";
import { mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { LlmAdapter } from "@x-harness/llm";
import { probeBaseFacts, createBasePromptPlugin, createAgentWorld, durableSessionKit, inlineSessionKit, truncationMessagesKit, toolboxKit, fenceKit, planKit, mailboxKit, workflowKit, meterKit, llmKit, loopKit, continuationKit, errorRecoveryKit, checkpointKit, taskLogsRootOf, promptKit, skillKit, delegationKit } from "@x-harness/harness";
import type { World } from "@x-harness/harness";
import type { AgentHandle, AgentOptions } from "@x-harness/agent-loop";
import { userSkillsDirOf } from "../dirs.ts";

export interface AssemblySpec {
  cwd: string;
  trusted: boolean;
  sessionsRoot: string;
  agentDir: string;
  resumeId?: SessionId;
  mailboxRoot: string;
  workflowRoot: string;
  skillsDirs: readonly string[];
  rgBinDir: string | undefined;
  adapters: readonly LlmAdapter[];
  agentOptions: AgentOptions;
  persistence: "durable" | "inline";
  mainSessionId: SessionId;
  onWarn: (message: string) => void;
}

export interface AssemblyResult {
  world: World;
  handle: AgentHandle;
  sessionId: SessionId;
}

function trustedSkillsDirs(spec: AssemblySpec): readonly string[] {
  if (spec.skillsDirs.length > 0) return spec.skillsDirs;
  const user = userSkillsDirOf(spec.agentDir);
  return spec.trusted ? [join(spec.cwd, ".x-harness", "skills"), user] : [user];
}

function sessionKit(spec: AssemblySpec): readonly Plugin[] {
  return spec.persistence === "inline"
    ? inlineSessionKit()
    : durableSessionKit({ root: spec.sessionsRoot, onIoError: spec.onWarn });
}

export async function assembleAgent(spec: AssemblySpec): Promise<AssemblyResult> {
  const facts = probeBaseFacts({ cwd: spec.cwd, platform: process.platform, env: {} });
  const skillsDirs = trustedSkillsDirs(spec);
  const plugins: readonly Plugin[] = [
    ...promptKit(createBasePromptPlugin(facts)),
    ...sessionKit(spec),
    ...truncationMessagesKit(),
    ...toolboxKit({
      root: spec.cwd,
      ...(spec.rgBinDir !== undefined ? { rgBinDir: spec.rgBinDir } : {}),
      ...(spec.persistence === "durable" ? { taskLogDir: taskLogsRootOf(spec.sessionsRoot) } : {}),
    }),
    ...fenceKit({ root: spec.cwd }),
    ...planKit({ liftTo: "auto", mainSession: spec.mainSessionId }),
    ...mailboxKit({ root: spec.mailboxRoot, onWarn: spec.onWarn }),
    ...workflowKit({ root: spec.workflowRoot, mainSession: spec.mainSessionId, onWarn: spec.onWarn }),
    ...meterKit(),
    ...llmKit(spec.adapters),
    ...loopKit(),
    ...continuationKit(),
    ...errorRecoveryKit(),
    ...checkpointKit(),
    ...delegationKit(
      { agentsDirs: [], workspaceRoot: spec.cwd, onWarn: spec.onWarn },
      facts,
    ),
    ...skillKit({ skillsDirs }),
  ];
  const world = await createAgentWorld({ plugins });
  if (!world.ok) throw new Error(world.reason);
  const handle = spec.resumeId !== undefined
    ? await world.value.loop.resume({ id: spec.resumeId, agent: spec.agentOptions })
    : await world.value.loop.create({
        agent: spec.agentOptions,
        session: { header: { id: spec.mainSessionId, createdAt: Date.now(), cwd: spec.cwd } },
      });
  if (!handle.ok) {
    await teardown(world.value);
    throw new Error(handle.reason);
  }
  return { world: world.value, handle: handle.value, sessionId: handle.value.agent.session.id };
}

const tornDown = new WeakSet<object>();

export async function teardown(world: World): Promise<void> {
  if (tornDown.has(world)) return;
  tornDown.add(world);
  for (const disposer of world.unload) await disposer();
  await world.ctx.dispose();
}

export function mintMainSessionId(): SessionId {
  return mintSessionId();
}
