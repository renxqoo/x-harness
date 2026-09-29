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

/** live-only 命令：非 live 表项态（parked/dead/retiring/spawning）host 本地拒 thread_not_live——
 *  不入 wake（parked 唤醒会复活 worker 跑一轮 LLM）、不入 retiring requeue（过期通告延迟材料化）。
 *  routeLine 判定序：表项查找后、retiring requeue 前（SESSION-WORKTREE-WORKFLOW §1.2）。 */
export const LIVE_ONLY_COMMANDS: ReadonlySet<string> = new Set(["thread/notify"]);

export function isLiveOnly(command: string): boolean {
  return LIVE_ONLY_COMMANDS.has(command);
}

export function isThreadScoped(command: string): boolean {
  return THREAD_SCOPED_COMMANDS.has(command);
}

export function isInternalId(id: string): boolean {
  return id.startsWith(INTERNAL_ID_PREFIX);
}
