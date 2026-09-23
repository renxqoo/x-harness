// 会话级设置命令（DESIGN §3.9 worker 面）：set/get_thinking_level（session/meta
// 独立键持久化 + agentRequest 挂点下一 turn 生效——写者 append+flush 直写纪律；
// 词表校验先于流式拒）与 permission/set_mode|get_mode（permissionMode 服务即时切 +
// WAL 持久化——唤醒无回落；controller.set 后置到 flush 成功）。
import { hubError } from "../shared/errors.ts";
import { parseRule } from "@x-harness/permission";
import { permissionGrantStore, permissionGrants } from "@x-harness/permission";
import { projectSettingsPath, readHubSettings, readProjectSettings, updateSettingsFile, userSettingsPath } from "../shared/settings-store.ts";
import { respond, requireThread, wrapSyncHandler } from "./worker-commands.ts";
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
    // 在飞拒 = 受理窗口同口径（pendingSends ∨ streaming）——已 ack 未起跑的 turn
    // 不得捡新档
    if (rt.pendingSends > 0 || rt.bridge.isStreaming()) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: hubError("streaming_window", "thread is streaming") });
      return;
    }
    // 写前单点：当前拨号换 thinking（provider/model 原样保留）
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
    // 尾值存在 → session；无尾值 → 装配物化归因（user/project 四态溯源）；皆无 → off
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

  handlers.set("permission/set_mode", async (input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/set_mode" });
    if (session === undefined) return;
    const mode = input.mode;
    // 值域 = 内置 ∪ 当前 settings 自定义档（对抗审查 #13——自定义档经 set_mode 可达）
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
    // 即时切档后置到持久化成功（报失败但提权成功是最坏方向——安全不变量）
    rt.state.permissionService?.set(permissionModeOf(mode) as import("@x-harness/permission").ProfileId);
    respond(rt, { id: input.id, command: "permission/set_mode" });
  });

  handlers.set("permission/get_mode", wrapSyncHandler((input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/get_mode" });
    if (session === undefined) return;
    // source 判据：WAL 有档 → session；否则装配来源快照（四态）
    const walMode = permissionModeOf(metaTailOf(session.events(), META_KEY_PERMISSION));
    const current = rt.state.permissionService?.get();
    respond(rt, {
      id: input.id,
      command: "permission/get_mode",
      data: {
        mode: walMode ?? current ?? "auto",
        source: walMode !== undefined ? "session" : (rt.permissionModeSource ?? "default"),
      },
    });
  }));

/** 规则串解析校验（命令面与文件面同判定——fail-closed；坏串 invalid_input） */
function parseRuleStrings(rules: readonly string[]): { ok: true; entries: import("@x-harness/permission").PermissionRule[] } | { ok: false; error: string } {
  try {
    return { ok: true, entries: rules.map((rule) => parseRule(rule, "user")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 习得授权写入（PERMISSION-V2 §6.2）：session=当前会话授权桶；project/user=settings
// 持久层（project 需 trusted）。NEVER_MEMORIZE 由 verdict=allow + 规则形态面共同守门。
/** grant 写入守门词表（对抗审查 #12）：万配/硬拒族/wrapper·解释器前缀不得习得 */
const GRANT_BLOCKED_HEADS: ReadonlySet<string> = new Set([
  "sudo", "doas", "su", "rm", "mkfs", "dd", "chmod", "chown", "bash", "sh", "zsh", "dash", "ksh",
  "env", "node", "python", "python3", "perl", "ruby", "php", "osascript", "eval", "xargs", "awk", "sed",
]);

/** grant 入参裁决：{rule, scope} 形态 + 恒 allow + 万配/硬拒族/wrapper 前缀拒（NEVER_MEMORIZE 命令面） */
function grantInputOf(input: CommandInput): { ok: true; scope: "session" | "project" | "user"; tool: import("@x-harness/permission").RuleTool; pattern: string } | { ok: false } {
  const scope = input.scope;
  const rule = input.rule;
  if (typeof rule !== "string" || (scope !== "session" && scope !== "project" && scope !== "user")) return { ok: false };
  const parsed = parseRuleStrings([rule]);
  if (!parsed.ok || parsed.entries[0] === undefined || parsed.entries[0].verdict !== "allow") return { ok: false };
  const entry = parsed.entries[0];
  if (entry.tool === "Bash") {
    if (entry.pattern === "*") return { ok: false }; // 万配不习得
    const head = entry.pattern.replace(/:\*$/, "").split(/\s+/)[0] ?? "";
    if (GRANT_BLOCKED_HEADS.has(head)) return { ok: false }; // 硬拒族/wrapper·解释器前缀不习得
  }
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

// 规则清单：session 授权桶 + settings 两作用域（管理面/对账）
handlers.set("permission/list_rules", async (input: CommandInput) => {
  const thread = requireThread(rt, { ...input, command: "permission/list_rules" });
  if (thread === undefined) return;
  const grants = rt.state.world?.ctx.tryUse(permissionGrants);
  const sessionRules = (grants?.rulesOf(rt.state.handle?.agent.session.id) ?? []).map((entry) => ({
    tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature ?? "handwritten", at: entry.at, scope: "session" as const,
  }));
  // 持久两作用域并入（管理面闭环：先列出才能删）
  const user = await readHubSettings(rt.agentDir);
  const project = rt.state.trusted ? await readProjectSettings(rt.state.cwd) : {};
  const settingsRules = [
    ...(user["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "user" as const })),
    ...(project["permission.rules"] ?? []).map((entry) => ({ tool: entry.tool, pattern: entry.pattern, verdict: entry.verdict, nature: entry.nature, at: entry.at, scope: "project" as const })),
  ];
  respond(rt, { id: input.id, command: "permission/list_rules", data: { rules: [...sessionRules, ...settingsRules] } });
});

// 规则删除：settings 作用域按 (scope,tool,pattern) 定位；session 作用域逐出整条
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
