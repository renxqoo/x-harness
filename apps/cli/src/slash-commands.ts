// slash 命令表与分派（docs/CLI.md §2.3）：闭集十命令，表即 /help 文档（词表封闭测试锚）。
// 依赖全注入（REPL 实现 reopen/compact/export 面），本文件只做解析/匹配/输出编排。

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
  /** 当前 dial + 是否内存会话（/model /resume 在内存会话下禁用——无 archive 无法 resume 重建） */
  readonly current: () => { readonly dial: SlashDial; readonly inMemory: boolean };
  readonly usageSummary: () => string;
  readonly sessionFacts: () => string;
  /** 换会话/换 dial：sessionId = 指定恢复；newSession = /new 新建；仅 dial = 当前会话重建；
   *  返回成功消息，失败返回错误文本 */
  readonly reopen: (over: { readonly sessionId?: SessionId; readonly newSession?: boolean; readonly dial?: SlashDial }) => Promise<string>;
  readonly listMainSessions: () => Promise<readonly SessionHeader[]>;
  readonly compact: (instructions: string | undefined) => Promise<string>;
  readonly exportTo: (path: string) => Promise<string>;
}

export type SlashOutcome = "handled" | "quit" | "unknown" | "not-slash";

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly help: string;
}

/** 命令闭集（= /help 输出，词表封闭断言锚点） */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", usage: "/help", help: "show this list" },
  { name: "quit", usage: "/quit", help: "exit (also Ctrl+C twice / Ctrl+D)" },
  { name: "new", usage: "/new", help: "start a new session (old one stays saved)" },
  { name: "model", usage: "/model [pattern]", help: "list/switch model" },
  { name: "thinking", usage: "/thinking [level]", help: `show/set thinking level (${THINKING_LEVELS.join("|")})` },
  { name: "session", usage: "/session", help: "session facts and token usage" },
  { name: "compact", usage: "/compact [instructions]", help: "fold history into a summary" },
  { name: "export", usage: "/export <path>", help: "export session events to a jsonl file" },
  { name: "resume", usage: "/resume", help: "pick a saved session to continue" },
  { name: "clear", usage: "/clear", help: "clear the screen" },
];

export function isSlashLine(line: string): boolean {
  return line.startsWith("/");
}

function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.usage.padEnd(28)}${command.help}`).join("\n");
}

/** pattern → (provider, model) 命中集：全档案 includes 匹配 */
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
    // 换 thinking 走 dispose→resume 重建，内存会话无 archive → 兜底会丢上下文，禁用
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
};

/** 分派：非 slash 行返回 not-slash；未知命令提示；/quit 返回 quit */
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
