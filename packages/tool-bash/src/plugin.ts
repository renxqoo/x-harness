import { createHash } from "node:crypto";
import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionBroker, summaryOf } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { createToolPlugin } from "@x-harness/tool-core";
import { PathGate } from "@x-harness/tool-core";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";
import { backgroundTasks } from "./tokens.ts";

export type BashLimitsOptions = Partial<Pick<BashLimits, "defaultTimeoutMs" | "maxTimeoutMs" | "maxOutputBytes" | "spillDir">>;

export type TaskLimitsOptions = { readonly maxConcurrentTasks?: number; readonly taskTimeoutMs?: number; readonly fullCapBytes?: number; readonly taskLogDir?: string };

export function bashGuidance(env: ExecEnv): string {
  const base = `## Shell

Commands run with no TTY and stdin closed: interactive prompts, pagers,
and editors cannot work — they fail, or hang until the timeout. Use
non-interactive forms instead: \`git commit -m\` and \`--no-pager\`,
confirmation flags like \`-y\`, scripts instead of REPL sessions.`;
  if (env.kind !== "sandbox") return base;
  return `${base}

Commands run inside an OS-level sandbox with a network domain allowlist.
A denied domain is a fence, not an obstacle to route around — ask the
user instead of trying to evade it.`;
}

export interface BashPluginInput {
  readonly gate?: PathGate;
  readonly env?: ExecEnv;
  readonly limits?: BashLimitsOptions;
  readonly tasks?: BackgroundTasks;
  readonly taskLimits?: TaskLimitsOptions;
}

export function createBashPlugin(input: BashPluginInput = {}): Plugin {
  const { env } = input;
  const gate = input.gate ?? new PathGate(process.cwd());
  if (input.tasks !== undefined && input.taskLimits !== undefined) {
    throw new Error("tool-bash: pass either tasks (external registry) or taskLimits, not both");
  }
  const limits = defaultLimits(input.limits ?? {});
  const tasks = input.tasks ?? new BackgroundTasks(defaultTaskLimits(input.taskLimits ?? {}));
  let worldCtx: import("@x-harness/core").Context | undefined;
  const escalated = new Map<string, Set<string>>();
  const escalate: import("./bash.ts").BashEscalate = async (fields) => {
    const broker = worldCtx?.tryUse(permissionBroker);
    if (broker === undefined) return "deny";
    const sessionKey = fields.session ?? "_anon";
    const commandKey = createHash("sha256").update(fields.command).digest("hex").slice(0, 16);
    const bucketNow = escalated.get(sessionKey) ?? new Set<string>();
    if (bucketNow.has(commandKey)) return "deny";
    bucketNow.add(commandKey);
    escalated.set(sessionKey, bucketNow);
    const summary = summaryOf(fields);
    const reply = await broker.ask({
      tool: "bash",
      ...(summary !== undefined ? { summary } : {}),
      reason: "sandbox failure — retry outside the sandbox?",
      options: ["once"],
      escalate: { command: fields.command, failureText: fields.failureText },
      ...(fields.session !== undefined ? { session: fields.session } : {}),
    });
    return reply.verdict;
  };

  return createToolPlugin({
    name: "tool-bash",
    envOption: env,
    gate,
    make: (resolved, _extraRootsOf, rootOverrideOf) => createBashTool({ gate, limits, env: resolved, tasks, rootOverrideOf, escalate }),
    guidance: bashGuidance,
    attach: (ctx) => {
      worldCtx = ctx;
      const offProvide = ctx.provide(backgroundTasks, tasks);
      const off = ctx.on(sessionDisposed, ({ session }) => tasks.evict(session));
      return () => {
        off();
        offProvide();
        tasks.stopAll();
      };
    },
  });
}
