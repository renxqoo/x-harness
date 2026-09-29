import type { AgentOptions } from "@x-harness/agent-loop";
import type { CliArgs } from "./parse-cli-args.ts";
import type { ModelChoice } from "./resolve-model.ts";

export function resolveToolNames(args: CliArgs, registered: readonly string[]): readonly string[] {
  if (args.noTools) return [];
  const exclude = args.excludeTools ?? [];
  if (args.tools === undefined) {
    return exclude.length === 0 ? registered : registered.filter((name) => !exclude.includes(name));
  }
  return args.tools.filter((name) => !exclude.includes(name));
}

export function agentOptionsForCreate(args: CliArgs, defaults: ModelChoice): AgentOptions {
  return {
    provider: defaults.provider,
    model: defaults.model,
    ...(defaults.thinking !== undefined ? { thinking: defaults.thinking } : {}),
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
  };
}

export function agentOptionsForResume(args: CliArgs, overrides: Partial<ModelChoice>): AgentOptions {
  return {
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {}),
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
  };
}
