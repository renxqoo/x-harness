import type { Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import { agentSpawned, agentWorktreeGone } from "@x-harness/agent-delegation";
import type { AgentSpawnedPayload, AgentWorktreeGonePayload } from "@x-harness/agent-delegation";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { baseCoreText } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";

export interface WorktreeContextOptions {
  readonly facts: BasePromptFacts;
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function worktreeEnvironmentBlock(facts: BasePromptFacts, payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string {
  const worktree = inline(payload.worktree);
  const branch = payload.branch !== undefined ? inline(payload.branch) : "";
  const main = payload.worktreeMain !== undefined ? inline(payload.worktreeMain) : "";
  const lines = [
    "You have been invoked in the following environment:",
    `- Working directory: ${worktree}`,
    "- Is a git repository: yes",
  ];
  if (branch !== "") lines.push(`- Git branch: ${branch}`);
  if (main !== "") {
    lines.push(`- Git worktree of: ${main}`);
    lines.push(`- The main repository at ${main} is outside your sandbox: treat it as a read-only reference`);
  }
  lines.push(`- Platform: ${facts.platform}`, `- Shell: ${facts.shell}`);
  return lines.join("\n");
}

const ENV_HEAD = "You have been invoked in the following environment:";
const ENV_TAIL = "## Context Management";

function worktreeCoreText(options: WorktreeContextOptions, payload: { readonly worktree: string; readonly branch?: string; readonly worktreeMain?: string }): string | undefined {
  const covered: BasePromptFacts = {
    ...options.facts,
    gitBranch: payload.branch,
    ...(payload.worktreeMain !== undefined && payload.worktreeMain !== "" ? { gitWorktreeMain: payload.worktreeMain } : {}),
  };
  const text = baseCoreText(covered);
  const head = text.indexOf(ENV_HEAD);
  const tail = text.indexOf(ENV_TAIL);
  if (head === -1 || tail === -1) return undefined;
  return `${text.slice(0, head)}${worktreeEnvironmentBlock(options.facts, payload)}\n\n${text.slice(tail)}`;
}

export function createWorktreeContextPlugin(options: WorktreeContextOptions): Plugin {
  return {
    name: "worktree-context",
    inject: ["system-prompt"],
    apply: (ctx): Disposer => {
      const prompt = ctx.use(systemPrompt);
      const layers = new Map<string, () => void>();
      const onSpawned = (payload: AgentSpawnedPayload): void => {
        if (payload.worktree === undefined || payload.worktree === "") return;
        const text = worktreeCoreText(options, { worktree: payload.worktree, ...(payload.branch !== undefined && payload.branch !== "" ? { branch: payload.branch } : {}), ...(payload.worktreeMain !== undefined ? { worktreeMain: payload.worktreeMain } : {}) });
        if (text === undefined) return;
        const sessionId = String(payload.sessionId);
        layers.get(sessionId)?.();
        const off = prompt.scoped(sessionId).section({ name: wellKnown.baseCore, text });
        layers.set(sessionId, off);
      };
      const drop = (sessionId: string): void => {
        const off = layers.get(sessionId);
        if (off !== undefined) {
          off();
          layers.delete(sessionId);
        }
      };
      const offs = [
        ctx.on(agentSpawned, onSpawned),
        ctx.on(agentWorktreeGone, (payload: AgentWorktreeGonePayload) => drop(String(payload.sessionId))),
        ctx.on(sessionDisposed, ({ session }) => drop(String(session))),
      ];
      return () => {
        for (const off of offs) off();
        for (const entry of layers.entries()) {
          entry[1]();
          layers.delete(entry[0]);
        }
      };
    },
  };
}
