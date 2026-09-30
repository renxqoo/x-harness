export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_BACKEND_ID = "x-harness";
export const INTERNAL_ID_PREFIX = "@hub-internal:";

export interface HelloFrame {
  type: "hello";
  protocolVersion: number;
  backendId: string;
}

export interface WorkerHeartbeat {
  type: "heartbeat";
  idleMs: number;
  streaming: boolean;
  sessionPath: string | null;
  rssBytes: number | null;
}

export const COMMAND_NAMES: readonly string[] = [
  "thread/start",
  "thread/resume",
  "thread/register",
  "thread/stop",
  "thread/notify",
  "thread/retire",
  "thread/set_keepalive",
  "thread/list",
  "thread/list_saved",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "queue/drop",
  "queue/send_now",
  "compact",
  "get_state",
  "get_inflight",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_token_analytics",
  "set_session_name",
  "get_commands",
  "get_fork_messages",
  "get_subagents",
  "get_plugins",
  "catalog/reload",
  "get_pending_dialogs",
  "fork",
  "clone",
  "get_models",
  "models/reload",
  "set_model",
  "set_model_override",
  "auth/list",
  "auth/set_api_key",
  "auth/remove_key",
  "bash",
  "abort_bash",
  "ui_response",
  "agents/list",
  "agents/create",
  "agents/remove",
  "subagent/steer",
  "workflow/list",
  "workflow/submit",
  "workflow/stop",
  "skills/inspect",
  "skills/list",
  "skills/install",
  "skills/set_enabled",
  "skills/remove",
  "settings/get",
  "settings/set",
  "models/add",
  "models/remove",
  "set_thinking_level",
  "get_thinking_level",
  "permission/set_mode",
  "permission/get_mode",
  "permission/grant",
  "permission/list_rules",
  "permission/remove_rule",
  "get_host_info",
  "set_idle_retire_ms",
  "set_rss_retire_bytes",
  "workspace/trust",
  "thread/delete",
  "plugins/list",
  "plugins/inspect",
  "plugins/install",
  "plugins/uninstall",
  "plugins/set_enabled",
  "plugins/remove",
  "plugins/hot_install",
  "plugins/hot_uninstall",
  "plugins/trusted_source/list",
  "plugins/trusted_source/confirm",
  "plugins/trusted_source/reject",
] as const;

export const THREAD_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/resume",
  "thread/stop",
  "thread/notify",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "queue/drop",
  "queue/send_now",
  "compact",
  "get_state",
  "get_inflight",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_token_analytics",
  "set_session_name",
  "get_commands",
  "get_fork_messages",
  "get_subagents",
  "get_pending_dialogs",
  "fork",
  "clone",
  "set_model",
  "bash",
  "abort_bash",
  "subagent/steer",
  "workflow/list",
  "workflow/submit",
  "workflow/stop",
  "set_thinking_level",
  "get_thinking_level",
  "plugins/hot_install",
  "plugins/hot_uninstall",
  "get_plugins",
  "catalog/reload",
]);

export const HOST_RELAYED_THREAD_COMMANDS: ReadonlySet<string> = new Set(["permission/set_mode", "permission/get_mode", "permission/grant", "permission/list_rules", "permission/remove_rule"]);

export const OBSERVER_COMMANDS: ReadonlySet<string> = new Set([
  "thread/notify",
  "get_state",
  "get_inflight",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_token_analytics",
  "get_commands",
  "get_fork_messages",
  "get_subagents",
  "get_plugins",
  "get_pending_dialogs",
  "get_thinking_level",
  "permission/get_mode",
  "permission/list_rules",
]);

export const DRIVING_COMMANDS: ReadonlySet<string> = new Set(["prompt", "steer", "follow_up"]);

export const LIVE_ONLY_COMMANDS: ReadonlySet<string> = new Set(["thread/notify"]);

export const PARKED_DIRECT_COMMANDS: ReadonlySet<string> = new Set(["get_state", "get_entries", "get_inflight", "get_subagents", "get_pending_dialogs"]);

export function isLiveOnly(command: string): boolean {
  return LIVE_ONLY_COMMANDS.has(command);
}

export function isThreadScoped(command: string): boolean {
  return THREAD_SCOPED_COMMANDS.has(command);
}

export function isKnownCommand(command: string): boolean {
  return COMMAND_NAMES.includes(command);
}

export function isInternalId(id: string): boolean {
  return id.startsWith(INTERNAL_ID_PREFIX);
}
