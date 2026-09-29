import { hubError } from "../shared/errors.ts";
import { memoryBlocked, parseRule } from "@x-harness/permission";
import { permissionGrantStore, permissionGrants } from "@x-harness/permission";
import { planControl } from "@x-harness/tool-plan";
import { projectSettingsPath, readHubSettings, readProjectSettings, updateSettingsFile, userSettingsPath } from "../shared/settings-store.ts";
import { respond, requireThread, wrapSyncHandler } from "./worker-commands.ts";
import { modeVocabulary } from "../shared/mode-vocab.ts";
import type { CommandInput, Handler, WorkerRuntime } from "./worker-commands.ts";
import {
  currentDialOf,
  metaTailOf,
  permissionModeOf,
  thinkingLevelOf,
  thinkingUnsupported,
  PERMISSION_MODES,
  THINKING_LEVELS,
  META_KEY_PERMISSION,
  META_KEY_THINKING,
} from "./meta-state.ts";

export function registerMetaCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("set_thinking_level", async (input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "set_thinking_level" });
    if (session === undefined) return;
    const level = input.level;
    if (typeof level !== "string" || !THINKING_LEVELS.includes(level as never)) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("invalid_input", `invalid thinking level: ${String(level)}`) });
      return;
    }
    if (rt.pendingSends > 0 || rt.bridge.isStreaming()) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("streaming_window", "thread is streaming") });
      return;
    }
    const dial = currentDialOf(session.events(), rt.state.dial);
    const unsupported = thinkingUnsupported(rt.state.catalog, dial, level as never);
    if (unsupported !== undefined) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("capability_thinking", unsupported) });
      return;
    }
    const append = session.append("session/meta", { key: META_KEY_THINKING, value: level });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("io_failed", flushed.reason) });
      return;
    }
    respond(rt, { id: input.id, command: "set_thinking_level" });
  });

  handlers.set("get_thinking_level", wrapSyncHandler((input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "get_thinking_level" });
    if (session === undefined) return;
    const walLevel = thinkingLevelOf(metaTailOf(session.events(), META_KEY_THINKING));
    if (walLevel !== undefined) {
      respond(rt, { id: input.id, command: "get_thinking_level", data: { level: walLevel, source: "session" } });
      return;
    }
    const fallback = rt.thinkingFallback;
    respond(rt, {
      id: input.id,
      command: "get_thinking_level",
      data: fallback !== undefined ? { level: fallback.level, source: fallback.source } : { level: "off", source: "off" },
    });
  }));

function applyPermissionMode(rt: WorkerRuntime, session: { readonly id: import("@x-harness/session").SessionId }, mode: string): void {
  const control = rt.state.world?.ctx.tryUse(planControl);
  if (control !== undefined) {
    if (mode === "plan") {
      control.enter(session.id);
      return;
    }
    if (control.isPlan()) {
      control.exit(session.id, mode as never);
      return;
    }
  }
  rt.state.permissionService?.set(mode);
}

handlers.set("permission/set_mode", async (input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/set_mode" });
    if (session === undefined) return;
    const mode = input.mode;
    const userSettings = await readHubSettings(rt.agentDir);
    const projectSettings = rt.state.trusted ? await readProjectSettings(rt.state.cwd) : {};
    const customIds = [...(userSettings["permission.profiles"] ?? []), ...(projectSettings["permission.profiles"] ?? [])].map((row) => row.id);
    if (typeof mode !== "string" || (!PERMISSION_MODES.includes(mode) && !customIds.includes(mode))) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: hubError("invalid_input", `invalid permission mode: ${String(mode)}`) });
      return;
    }
    const append = session.append("session/meta", { key: META_KEY_PERMISSION, value: mode });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: hubError("io_failed", flushed.reason) });
      return;
    }
    applyPermissionMode(rt, session, mode);
    respond(rt, { id: input.id, command: "permission/set_mode" });
  });

  handlers.set("permission/get_mode", wrapSyncHandler((input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/get_mode" });
    if (session === undefined) return;
    const walMode = permissionModeOf(metaTailOf(session.events(), META_KEY_PERMISSION));
    const current = rt.state.permissionService?.get();
    respond(rt, {
      id: input.id,
      command: "permission/get_mode",
      data: {
        mode: walMode ?? current ?? "auto",
        source: walMode !== undefined ? "session" : (rt.permissionModeSource ?? "default"),
        modes: modeVocabulary(),
      },
    });
  }));

function parseRuleStrings(rules: readonly string[]): { ok: true; entries: import("@x-harness/permission").PermissionRule[] } | { ok: false; error: string } {
  try {
    return { ok: true, entries: rules.map((rule) => parseRule(rule, "user")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function grantInputOf(input: CommandInput): { ok: true; scope: "session" | "project" | "user"; tool: import("@x-harness/permission").RuleTool; pattern: string } | { ok: false } {
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

handlers.set("permission/grant", async (input: CommandInput) => {
  const thread = requireThread(rt, { ...input, command: "permission/grant" });
  if (thread === undefined) return;
  const granted = grantInputOf(input);
  if (!granted.ok) {
    respond(rt, { id: input.id, command: "permission/grant", error: hubError("invalid_input", "permission/grant requires {rule: string (allow rules only), scope: session|project|user}") });
    return;
  }
  const scope = granted.scope;
  if (scope === "session") {
    const grants = rt.state.world?.ctx.tryUse(permissionGrants);
    if (grants === undefined) {
      respond(rt, { id: input.id, command: "permission/grant", error: hubError("internal", "permission service unavailable") });
      return;
    }
    grants.addRule(rt.state.handle?.agent.session.id, { tool: granted.tool, pattern: granted.pattern, verdict: "allow", origin: "session", nature: "grant", at: Date.now() });
    respond(rt, { id: input.id, command: "permission/grant", data: { scope, rule: String(input.rule) } });
    return;
  }
  const store = rt.state.world?.ctx.tryUse(permissionGrantStore);
  if (store === undefined) {
    respond(rt, { id: input.id, command: "permission/grant", error: hubError("internal", "grant store unavailable") });
    return;
  }
  const written = await store.write(scope, { tool: granted.tool, pattern: granted.pattern, verdict: "allow", nature: "grant", at: Date.now() });
  if (!written.ok) {
    respond(rt, { id: input.id, command: "permission/grant", error: hubError("invalid_input", written.reason) });
    return;
  }
  respond(rt, { id: input.id, command: "permission/grant", data: { scope, rule: String(input.rule) } });
});

handlers.set("permission/list_rules", async (input: CommandInput) => {
  const thread = requireThread(rt, { ...input, command: "permission/list_rules" });
  if (thread === undefined) return;
  const grants = rt.state.world?.ctx.tryUse(permissionGrants);
  const sessionRules = (grants?.rulesOf(rt.state.handle?.agent.session.id) ?? []).map((entry) => ({
    tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature ?? "handwritten", at: entry.at, scope: "session" as const,
  }));
  const user = await readHubSettings(rt.agentDir);
  const project = rt.state.trusted ? await readProjectSettings(rt.state.cwd) : {};
  const settingsRules = [
    ...(user["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "user" as const })),
    ...(project["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "project" as const })),
  ];
  respond(rt, { id: input.id, command: "permission/list_rules", data: { rules: [...sessionRules, ...settingsRules] } });
});

handlers.set("permission/remove_rule", async (input: CommandInput) => {
  const thread = requireThread(rt, { ...input, command: "permission/remove_rule" });
  if (thread === undefined) return;
  const scope = input.scope;
  const tool = input.tool;
  const pattern = input.pattern;
  if ((scope !== "project" && scope !== "user" && scope !== "session") || typeof tool !== "string" || typeof pattern !== "string") {
    respond(rt, { id: input.id, command: "permission/remove_rule", error: hubError("invalid_input", "permission/remove_rule requires {scope, tool, pattern}") });
    return;
  }
  if (scope === "session") {
    respond(rt, { id: input.id, command: "permission/remove_rule", error: hubError("invalid_input", "session rules evict with the session — restart the thread instead") });
    return;
  }
  if (scope === "project" && !rt.state.trusted) {
    respond(rt, { id: input.id, command: "permission/remove_rule", error: hubError("invalid_input", "project scope requires a trusted workspace") });
    return;
  }
  try {
    const path = scope === "user" ? userSettingsPath(rt.agentDir) : projectSettingsPath(rt.state.cwd);
    let removed = false;
    await updateSettingsFile(path, (current) => {
      const rules = current["permission.rules"] ?? [];
      const next = rules.filter((entry) => !(entry.tool === tool && entry.pattern === pattern));
      removed = next.length !== rules.length;
      return { ...current, "permission.rules": next };
    });
    respond(rt, { id: input.id, command: "permission/remove_rule", data: { removed, scope, tool, pattern } });
  } catch (error) {
    respond(rt, { id: input.id, command: "permission/remove_rule", error: hubError("io_failed", error instanceof Error ? error.message : String(error)) });
  }
});
}
