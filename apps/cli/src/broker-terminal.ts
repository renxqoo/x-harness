import type { Plugin } from "@x-harness/core";
import { permissionBroker } from "@x-harness/permission";
import type { AskPayload, AskReply } from "@x-harness/permission";

export interface BrokerIO {
  readonly interactive: boolean;
  readonly write: (line: string) => void;
  readonly question: (prompt: string) => Promise<string | undefined>;
}

export function decideApproval(answer: string | undefined, options: readonly ("once" | "session" | "project" | "user")[]): AskReply {
  const trimmed = answer?.trim().toLowerCase();
  if (trimmed === "y" || trimmed === "yes") return { verdict: "allow" };
  if (trimmed === "s" && options.includes("session")) return { verdict: "allow", memory: "session" };
  if (trimmed === "p" && options.includes("project")) return { verdict: "allow", memory: "project" };
  if (trimmed === "u" && options.includes("user")) return { verdict: "allow", memory: "user" };
  return { verdict: "deny" };
}

export function approvalPromptOf(input: AskPayload): string {
  const memoryKeys: string[] = [];
  if (input.options.includes("session")) memoryKeys.push("[s] session");
  if (input.options.includes("project")) memoryKeys.push("[p] project");
  if (input.options.includes("user")) memoryKeys.push("[u] always");
  return memoryKeys.length > 0 ? `[y/N ${memoryKeys.join(" ")}]` : "[y/N] ";
}

async function askWith(io: BrokerIO, input: AskPayload): Promise<AskReply> {
  if (!io.interactive) {
    io.write(`permission denied (non-interactive stdin): ${input.tool} — ${input.reason}`);
    return { verdict: "deny" };
  }
  io.write(`allow ${input.tool}? — ${input.reason}`);
  if (input.suggestedRule !== undefined) io.write(`  suggested rule: ${input.suggestedRule}`);
  if (input.escalate !== undefined) io.write(`  sandboxed run failed:
${input.escalate.failureText}`);
  return decideApproval(await io.question(approvalPromptOf(input)), input.options);
}

export function createTerminalBrokerPlugin(io: BrokerIO): Plugin {
  return {
    name: "cli-permission-broker",
    apply: (ctx) => ctx.provide(permissionBroker, { ask: (input) => askWith(io, input) }),
  };
}
