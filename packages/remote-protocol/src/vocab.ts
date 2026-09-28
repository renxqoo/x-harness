// scope 执法矩阵（DESIGN §3.1/§3.2 表 = 单一真相；测试从本表生成）。
export type AccessTier = "read" | "interact" | "full" | "owner";

/** host 命令 → 各档可达性（60 命令全量，DESIGN §3.1） */
export const HOST_COMMAND_MATRIX: Readonly<Record<string, { read: boolean; interact: boolean; full: boolean; ownerOnly: boolean }>> = {
  "thread/start": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/resume": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/register": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/stop": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/retire": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/set_keepalive": { read: false, interact: true, full: true, ownerOnly: false },
  "thread/delete": { read: false, interact: false, full: false, ownerOnly: true },
  "thread/list": { read: true, interact: true, full: true, ownerOnly: false },
  "thread/list_saved": { read: true, interact: true, full: true, ownerOnly: false },
  prompt: { read: false, interact: true, full: true, ownerOnly: false },
  steer: { read: false, interact: true, full: true, ownerOnly: false },
  follow_up: { read: false, interact: true, full: true, ownerOnly: false },
  abort: { read: false, interact: true, full: true, ownerOnly: false },
  clear_queue: { read: false, interact: true, full: true, ownerOnly: false },
  "queue/drop": { read: false, interact: true, full: true, ownerOnly: false },
  "queue/send_now": { read: false, interact: true, full: true, ownerOnly: false },
  compact: { read: false, interact: true, full: true, ownerOnly: false },
  get_state: { read: true, interact: true, full: true, ownerOnly: false },
  get_inflight: { read: true, interact: true, full: true, ownerOnly: false },
  get_messages: { read: true, interact: true, full: true, ownerOnly: false },
  get_entries: { read: true, interact: true, full: true, ownerOnly: false },
  get_tree: { read: true, interact: true, full: true, ownerOnly: false },
  get_session_stats: { read: true, interact: true, full: true, ownerOnly: false },
  get_commands: { read: true, interact: true, full: true, ownerOnly: false },
  get_fork_messages: { read: true, interact: true, full: true, ownerOnly: false },
  set_session_name: { read: false, interact: true, full: true, ownerOnly: false },
  get_subagents: { read: true, interact: true, full: true, ownerOnly: false },
  get_pending_dialogs: { read: true, interact: true, full: true, ownerOnly: false },
  fork: { read: false, interact: true, full: true, ownerOnly: false },
  clone: { read: false, interact: true, full: true, ownerOnly: false },
  get_models: { read: true, interact: true, full: true, ownerOnly: false },
  set_model: { read: false, interact: true, full: true, ownerOnly: false },
  set_model_override: { read: false, interact: true, full: true, ownerOnly: false },
  "models/add": { read: false, interact: false, full: false, ownerOnly: true },
  "models/remove": { read: false, interact: false, full: false, ownerOnly: true },
  "auth/list": { read: false, interact: false, full: false, ownerOnly: true },
  "auth/set_api_key": { read: false, interact: false, full: false, ownerOnly: true },
  "auth/remove_key": { read: false, interact: false, full: false, ownerOnly: true },
  bash: { read: false, interact: false, full: true, ownerOnly: false },
  abort_bash: { read: false, interact: false, full: true, ownerOnly: false },
  ui_response: { read: false, interact: true, full: true, ownerOnly: false },
  "agents/list": { read: true, interact: true, full: true, ownerOnly: false },
  "agents/create": { read: false, interact: false, full: true, ownerOnly: false },
  "agents/remove": { read: false, interact: false, full: true, ownerOnly: false },
  "subagent/steer": { read: false, interact: true, full: true, ownerOnly: false },
  "skills/list": { read: true, interact: true, full: true, ownerOnly: false },
  "skills/set_enabled": { read: false, interact: false, full: true, ownerOnly: false },
  "skills/remove": { read: false, interact: false, full: true, ownerOnly: false },
  "skills/inspect": { read: false, interact: false, full: true, ownerOnly: false },
  "skills/install": { read: false, interact: false, full: true, ownerOnly: false },
  "settings/get": { read: false, interact: false, full: true, ownerOnly: false },
  "settings/set": { read: false, interact: false, full: false, ownerOnly: true },
  set_thinking_level: { read: false, interact: true, full: true, ownerOnly: false },
  get_thinking_level: { read: true, interact: true, full: true, ownerOnly: false },
  "permission/set_mode": { read: false, interact: true, full: true, ownerOnly: false },
  "permission/get_mode": { read: true, interact: true, full: true, ownerOnly: false },
  get_host_info: { read: false, interact: false, full: true, ownerOnly: false },
  set_idle_retire_ms: { read: false, interact: false, full: true, ownerOnly: false },
  set_rss_retire_bytes: { read: false, interact: false, full: true, ownerOnly: false },
  "workspace/trust": { read: false, interact: false, full: false, ownerOnly: true },
};

export const HOST_COMMANDS = Object.keys(HOST_COMMAND_MATRIX);

/** gateway 本地命令族（§3.2）：恒 owner-only（设备侧仅 gw/status 精简版） */
export const GW_COMMANDS = [
  "gw/status",
  "gw/devices/list",
  "gw/devices/rename",
  "gw/devices/set_scope",
  "gw/devices/revoke",
  "gw/pairing/start",
  "gw/pairing/cancel",
  "gw/pairing/confirm",
  "gw/config/get",
  "gw/config/set",
  "gw/logs/tail",
  "gw/shutdown",
] as const;
export type GwCommand = (typeof GW_COMMANDS)[number];

export type ScopeVerdict = "allow" | "owner-only" | "scope-denied" | "unknown-command";

/** 执法单点：tier=owner 走 owner-only 全放；设备档按矩阵。未知命令默认拒（S2 fail-closed） */
export function judgeHostCommand(command: string, tier: AccessTier): ScopeVerdict {
  const row = HOST_COMMAND_MATRIX[command];
  if (row === undefined) {
    return GW_COMMANDS.includes(command as GwCommand) ? "owner-only" : "unknown-command";
  }
  if (row.ownerOnly) {
    return tier === "owner" ? "allow" : "owner-only";
  }
  if (tier === "owner") return "allow";
  if (tier === "full") return row.full ? "allow" : "scope-denied";
  if (tier === "interact") return row.interact ? "allow" : "scope-denied";
  return row.read ? "allow" : "scope-denied";
}

/** gw/* 路由判定：owner 通道全放；设备通道仅 gw/status（精简版由 gateway 组装） */
export function judgeGwCommand(command: string, tier: AccessTier): ScopeVerdict {
  if (!GW_COMMANDS.includes(command as GwCommand)) return "unknown-command";
  if (tier === "owner") return "allow";
  return command === "gw/status" ? "allow" : "owner-only";
}
