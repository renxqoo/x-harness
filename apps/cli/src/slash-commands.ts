import type { SessionHeader, SessionId } from "@x-harness/session";
import { THINKING_LEVELS } from "./providers-file.ts";
import type { ProvidersConfig, ThinkingLevelCli } from "./providers-file.ts";
import { formatSessionList, pickIndex, pickSession } from "./pick-session.ts";

export interface SlashDial {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevelCli;
}

export interface SlashDeps {
  readonly write: (line: string) => void;
  readonly question: (prompt: string) => Promise<string | undefined>;
  readonly config: ProvidersConfig;
  readonly current: () => { readonly dial: SlashDial; readonly inMemory: boolean };
  readonly usageSummary: () => string;
  readonly sessionFacts: () => string;
  readonly reopen: (over: { readonly sessionId?: SessionId; readonly newSession?: boolean; readonly dial?: SlashDial }) => Promise<string>;
  readonly listMainSessions: () => Promise<readonly SessionHeader[]>;
  readonly compact: (instructions: string | undefined) => Promise<string>;
  readonly exportTo: (path: string) => Promise<string>;
  readonly workflow?: WorkflowCommandDeps;
  readonly permission?: PermissionCommandDeps;
}

export interface PermissionCommandDeps {
  readonly planToggle: () => string;
}

export type SlashOutcome = "handled" | "quit" | "unknown" | "not-slash";

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly help: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", usage: "/help", help: "show this list" },
  { name: "quit", usage: "/quit", help: "exit (also Ctrl+C twice / Ctrl+D)" },
  { name: "new", usage: "/new", help: "start a new session (old one stays saved)" },
  { name: "model", usage: "/model [pattern]", help: "list/switch model" },
  { name: "plan", usage: "/plan", help: "toggle plan mode (read-only research; lift via plan approval)" },
  { name: "thinking", usage: "/thinking [level]", help: `show/set thinking level (${THINKING_LEVELS.join("|")})` },
  { name: "session", usage: "/session", help: "session facts and token usage" },
  { name: "compact", usage: "/compact [instructions]", help: "fold history into a summary" },
  { name: "export", usage: "/export <path>", help: "export session events to a jsonl file" },
  { name: "resume", usage: "/resume", help: "pick a saved session to continue" },
  { name: "workflow", usage: "/workflow <run|stop|submit> ...", help: "managed tasks with acceptance gating" },
  { name: "clear", usage: "/clear", help: "clear the screen" },
];

export function isSlashLine(line: string): boolean {
  return line.startsWith("/");
}

function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)}${command.help}`).join("\n");
}

async function commandWorkflow(wf: WorkflowCommandDeps, rest: string | undefined): Promise<string> {
  const text = (rest ?? "").trim();
  if (text === "" || text === "run" || text === "runs") return await wf.workflowRuns();
  if (text.startsWith("stop ")) {
    const taskId = text.slice(5).trim();
    return taskId === "" ? "usage: /workflow stop <taskId>" : await wf.workflowStop(taskId);
  }
  if (text.startsWith("submit")) return await wf.workflowSubmit(text.slice(7).trim());
  return [
    "usage:",
    "  /workflow                       list runs",
    "  /workflow submit --verify <command> [--schema <json>] <task>",
    "  /workflow stop <taskId>",
  ].join("\n");
}

function matchModels(config: ProvidersConfig, pattern: string): { readonly provider: string; readonly model: string }[] {
  const hits: { provider: string; model: string }[] = [];
  for (const profile of config.providers) {
    for (const model of profile.models) {
      if (model.includes(pattern)) hits.push({ provider: profile.name, model });
    }
  }
  return hits;
}

async function commandModel(deps: SlashDeps, pattern: string | undefined): Promise<void> {
  if (deps.current().inMemory) {
    deps.write("model switch requires a persisted session (this one is in-memory)");
    return;
  }
  const all = deps.config.providers.flatMap((profile) => profile.models.map((model) => ({ provider: profile.name, model })));
  const hits = pattern === undefined || pattern === "" ? all : matchModels(deps.config, pattern);
  if (pattern === undefined || pattern === "") {
    deps.write(hits.map((hit, index) => `${String(index + 1)}. ${hit.provider}  ${hit.model}`).join("\n"));
  } else if (hits.length === 0) {
    deps.write(`no model matches "${pattern}"`);
    return;
  } else if (hits.length === 1) {
    const only = hits[0];
    if (only !== undefined) deps.write(await deps.reopen({ dial: only }));
    return;
  } else {
    deps.write(hits.map((hit, index) => `${String(index + 1)}. ${hit.provider}  ${hit.model}`).join("\n"));
  }
  const index = await pickIndex(hits.length, deps.question);
  const chosen = index === undefined ? undefined : hits[index];
  if (chosen !== undefined) deps.write(await deps.reopen({ dial: chosen }));
}

async function commandThinking(deps: SlashDeps, level: string | undefined): Promise<void> {
  if (level !== undefined && level !== "" && deps.current().inMemory) {
    deps.write("thinking switch requires a persisted session (this one is in-memory)");
    return;
  }
  if (level === undefined || level === "") {
    deps.write(`thinking: ${deps.current().dial.thinking ?? "off"}`);
    return;
  }
  if (!THINKING_LEVELS.includes(level as ThinkingLevelCli)) {
    deps.write(`thinking level must be one of ${THINKING_LEVELS.join(" | ")}`);
    return;
  }
  deps.write(await deps.reopen({ dial: { thinking: level as ThinkingLevelCli } }));
}

async function commandResume(deps: SlashDeps): Promise<void> {
  if (deps.current().inMemory) {
    deps.write("resume requires an archive (this session is in-memory)");
    return;
  }
  const headers = await deps.listMainSessions();
  if (headers.length === 0) {
    deps.write("no saved sessions");
    return;
  }
  deps.write(formatSessionList(headers).join("\n"));
  const picked = await pickSession(headers, deps.question);
  if (picked === undefined) return;
  deps.write(await deps.reopen({ sessionId: picked }));
}

export interface WorkflowCommandDeps {
  workflowSubmit(args: string): Promise<string>;
  workflowStop(taskId: string): Promise<string>;
  workflowRuns(): Promise<string>;
}

type Handler = (deps: SlashDeps, rest: string | undefined) => Promise<void> | void;

const HANDLERS: Readonly<Record<string, Handler>> = {
  help: (deps) => deps.write(helpText()),
  quit: () => {},
  clear: (deps) => deps.write("\x1b[2J\x1b[H"),
  new: async (deps) => deps.write(await deps.reopen({ newSession: true })),
  session: (deps) => deps.write([deps.sessionFacts(), deps.usageSummary()].join("\n")),
  model: (deps, rest) => commandModel(deps, rest === "" ? undefined : rest),
  thinking: (deps, rest) => commandThinking(deps, rest === "" ? undefined : rest),
  compact: async (deps, rest) => deps.write(await deps.compact(rest === "" ? undefined : rest)),
  export: async (deps, rest) => {
    if (rest === undefined || rest === "") {
      deps.write("usage: /export <path>");
      return;
    }
    deps.write(await deps.exportTo(rest));
  },
  resume: (deps) => commandResume(deps),
  workflow: async (deps, rest) => deps.workflow === undefined ? deps.write("workflow is not assembled in this build") : deps.write(await commandWorkflow(deps.workflow, rest)),
  plan: (deps) => deps.write(deps.permission === undefined ? "permission is not assembled in this build" : deps.permission.planToggle()),
};

export async function runSlashCommand(line: string, deps: SlashDeps): Promise<SlashOutcome> {
  const trimmed = line.trim();
  if (!isSlashLine(trimmed)) return "not-slash";
  const space = trimmed.indexOf(" ");
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1);
  const rest = space === -1 ? undefined : trimmed.slice(space + 1).trim();
  const handler = HANDLERS[name];
  if (handler === undefined) {
    deps.write(`unknown command: ${name} — try /help`);
    return "unknown";
  }
  if (name !== "quit") {
    await handler(deps, rest);
    return "handled";
  }
  return "quit";
}
