import type { Session, SessionId } from "@x-harness/session";
import type { World } from "@x-harness/harness";
import { memoryBlocked, parseRule } from "@x-harness/permission";
import { permissionGrantStore, permissionGrants } from "@x-harness/permission";
import type { RuleEntry } from "@x-harness/permission";
import type { PermissionRule, RuleTool } from "@x-harness/permission";
import { planControl } from "@x-harness/tool-plan";
import { projectSettingsPath, readHubSettings, readProjectSettings, updateSettingsFile, userSettingsPath } from "../shared/settings-store.ts";
import { hubError } from "../shared/errors.ts";
import { modeVocabulary } from "../shared/mode-vocab.ts";
import { foldDial } from "../shared/meta-fold.ts";
import {
  thinkingLevelOf,
  permissionModeOf,
  thinkingUnsupported,
  PERMISSION_MODES,
  THINKING_LEVELS,
  META_KEY_PERMISSION,
  META_KEY_THINKING,
  metaTailOf,
} from "./meta-state.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface MetaCommandState {
  session: Session | undefined;
  threadId: string;
  agentDir: string;
  cwd: string;
  trusted: boolean;
  catalog: import("../shared/worker-catalog.ts").WorkerCatalog;
  dial: import("../shared/meta-fold.ts").DialFact;
  thinkingFallback: { level: import("@x-harness/llm").ThinkingLevel; source: string } | undefined;
  permissionModeSource: string | undefined;
  world: World | undefined;
  permissionService: { set(mode: string): void; get(): string | undefined } | undefined;
  streaming(): boolean;
}

function outcomeError(command: string, code: Parameters<typeof hubError>[0], message: string): CommandOutcome {
  return { command, error: hubError(code, message) };
}

export async function setThinkingLevel(state: MetaCommandState, level: unknown): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return outcomeError("set_thinking_level", "unknown_thread", "Unknown threadId");
  if (typeof level !== "string" || !THINKING_LEVELS.includes(level as never)) {
    return outcomeError("set_thinking_level", "invalid_input", `invalid thinking level: ${String(level)}`);
  }
  if (state.streaming()) return outcomeError("set_thinking_level", "streaming_window", "thread is streaming");
  const unsupported = thinkingUnsupported(state.catalog, { provider: dialFoldProvider(state, session), model: dialFoldModel(state, session) }, level as never);
  if (unsupported !== undefined) return outcomeError("set_thinking_level", "capability_thinking", unsupported);
  const append = session.append("session/meta", { key: META_KEY_THINKING, value: level });
  if (!append.ok) return outcomeError("set_thinking_level", "io_failed", append.reason);
  const flushed = await state.world?.store.flush(session.id);
  if (flushed !== undefined && !flushed.ok) return outcomeError("set_thinking_level", "io_failed", flushed.reason);
  return { command: "set_thinking_level" };
}

function dialFoldProvider(state: MetaCommandState, session: Session): string {
  return foldDialOf(state, session).provider;
}

function dialFoldModel(state: MetaCommandState, session: Session): string {
  return foldDialOf(state, session).model;
}

function foldDialOf(state: MetaCommandState, session: Session): { provider: string; model: string } {
  return foldDial(session.events(), state.dial);
}

export function getThinkingLevel(state: MetaCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return outcomeError("get_thinking_level", "unknown_thread", "Unknown threadId");
  const walLevel = thinkingLevelOf(metaTailOf(session.events(), META_KEY_THINKING));
  if (walLevel !== undefined) return { command: "get_thinking_level", data: { level: walLevel, source: "session" } };
  const fallback = state.thinkingFallback;
  return {
    command: "get_thinking_level",
    data: fallback !== undefined ? { level: fallback.level, source: fallback.source } : { level: "off", source: "off" },
  };
}

export function applyPermissionMode(state: MetaCommandState, sessionId: SessionId, mode: string): void {
  const control = state.world?.ctx.tryUse(planControl) as { enter(id: SessionId): void; exit(id: SessionId, mode: never): void; isPlan(): boolean } | undefined;
  if (control !== undefined) {
    if (mode === "plan") {
      control.enter(sessionId);
      return;
    }
    if (control.isPlan()) {
      control.exit(sessionId, mode as never);
      return;
    }
  }
  state.permissionService?.set(mode);
}

export async function setPermissionMode(state: MetaCommandState, mode: unknown): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return outcomeError("permission/set_mode", "unknown_thread", "Unknown threadId");
  const userSettings = await readHubSettings(state.agentDir);
  const projectSettings = state.trusted ? await readProjectSettings(state.cwd) : {};
  const customIds = [...(userSettings["permission.profiles"] ?? []), ...(projectSettings["permission.profiles"] ?? [])].map((row) => row.id);
  if (typeof mode !== "string" || (!PERMISSION_MODES.includes(mode) && !customIds.includes(mode))) {
    return outcomeError("permission/set_mode", "invalid_input", `invalid permission mode: ${String(mode)}`);
  }
  const append = session.append("session/meta", { key: META_KEY_PERMISSION, value: mode });
  if (!append.ok) return outcomeError("permission/set_mode", "io_failed", append.reason);
  const flushed = await state.world?.store.flush(session.id);
  if (flushed !== undefined && !flushed.ok) return outcomeError("permission/set_mode", "io_failed", flushed.reason);
  applyPermissionMode(state, session.id, mode);
  return { command: "permission/set_mode" };
}

export function getPermissionMode(state: MetaCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return outcomeError("permission/get_mode", "unknown_thread", "Unknown threadId");
  const walMode = thinkingLevelOfPermission(session);
  const current = state.permissionService?.get();
  return {
    command: "permission/get_mode",
    data: {
      mode: walMode ?? current ?? "auto",
      source: walMode !== undefined ? "session" : (state.permissionModeSource ?? "default"),
      modes: modeVocabulary(),
    },
  };
}

function thinkingLevelOfPermission(session: Session): string | undefined {
  return permissionModeOf(metaTailOf(session.events(), META_KEY_PERMISSION));
}

function parseRuleStrings(rules: readonly string[]): { ok: true; entries: PermissionRule[] } | { ok: false; error: string } {
  try {
    return { ok: true, entries: rules.map((rule) => parseRule(rule, "user")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function grantInputOf(input: Record<string, unknown>): { ok: true; scope: "session" | "project" | "user"; tool: RuleTool; pattern: string } | { ok: false } {
  const scope = input.scope;
  const rule = input.rule;
  if (typeof rule !== "string" || (scope !== "session" && scope !== "project" && scope !== "user")) return { ok: false };
  const parsed = parseRuleStrings([rule]);
  if (!parsed.ok || parsed.entries[0] === undefined || parsed.entries[0].verdict !== "allow") return { ok: false };
  const entry = parsed.entries[0];
  if (entry.tool === "Danger") {
    if (entry.pattern === "*") return { ok: false };
    if (memoryBlocked(entry.pattern)) return { ok: false };
  }
  if (entry.tool === "Tool") return { ok: false };
  return { ok: true, scope, tool: entry.tool, pattern: entry.pattern };
}

export async function permissionGrant(state: MetaCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return outcomeError("permission/grant", "unknown_thread", "Unknown threadId");
  const granted = grantInputOf(input);
  if (!granted.ok) {
    return outcomeError("permission/grant", "invalid_input", "permission/grant requires {rule: string (allow rules only), scope: session|project|user}");
  }
  const scope = granted.scope;
  if (scope === "session") {
    const grants = state.world?.ctx.tryUse(permissionGrants) as { addRule(id: SessionId, rule: PermissionRule): void } | undefined;
    if (grants === undefined) return outcomeError("permission/grant", "internal", "permission service unavailable");
    grants.addRule(session.id, { tool: granted.tool, pattern: granted.pattern, verdict: "allow", origin: "session", nature: "grant", at: Date.now() });
    return { command: "permission/grant", data: { scope, rule: String(input.rule) } };
  }
  const store = state.world?.ctx.tryUse(permissionGrantStore) as { write(scope: "project" | "user", entry: RuleEntry): Promise<{ ok: true } | { ok: false; reason: string }> } | undefined;
  if (store === undefined) return outcomeError("permission/grant", "internal", "grant store unavailable");
  const written = await store.write(scope, { tool: granted.tool, pattern: granted.pattern, verdict: "allow", nature: "grant", at: Date.now() });
  if (!written.ok) return outcomeError("permission/grant", "invalid_input", written.reason);
  return { command: "permission/grant", data: { scope, rule: String(input.rule) } };
}

export async function permissionListRules(state: MetaCommandState): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return outcomeError("permission/list_rules", "unknown_thread", "Unknown threadId");
  const grants = state.world?.ctx.tryUse(permissionGrants) as { rulesOf(id: SessionId): PermissionRule[] } | undefined;
  const sessionRules = (grants?.rulesOf(session.id) ?? []).map((entry) => ({
    tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature ?? "handwritten", at: entry.at, scope: "session" as const,
  }));
  const user = await readHubSettings(state.agentDir);
  const project = state.trusted ? await readProjectSettings(state.cwd) : {};
  const settingsRules = [
    ...(user["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "user" as const })),
    ...(project["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "project" as const })),
  ];
  return { command: "permission/list_rules", data: { rules: [...sessionRules, ...settingsRules] } };
}

export async function permissionRemoveRule(state: MetaCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return outcomeError("permission/remove_rule", "unknown_thread", "Unknown threadId");
  const scope = input.scope;
  const tool = input.tool;
  const pattern = input.pattern;
  if ((scope !== "project" && scope !== "user" && scope !== "session") || typeof tool !== "string" || typeof pattern !== "string") {
    return outcomeError("permission/remove_rule", "invalid_input", "permission/remove_rule requires {scope, tool, pattern}");
  }
  if (scope === "session") {
    return outcomeError("permission/remove_rule", "invalid_input", "session rules evict with the session — restart the thread instead");
  }
  if (scope === "project" && !state.trusted) {
    return outcomeError("permission/remove_rule", "invalid_input", "project scope requires a trusted workspace");
  }
  try {
    const path = scope === "user" ? userSettingsPath(state.agentDir) : projectSettingsPath(state.cwd);
    let removed = false;
    await updateSettingsFile(path, (current) => {
      const rules = current["permission.rules"] ?? [];
      const next = rules.filter((entry) => !(entry.tool === tool && entry.pattern === pattern));
      removed = next.length !== rules.length;
      return { ...current, "permission.rules": next };
    });
    return { command: "permission/remove_rule", data: { removed, scope, tool, pattern } };
  } catch (error) {
    return outcomeError("permission/remove_rule", "io_failed", error instanceof Error ? error.message : String(error));
  }
}
