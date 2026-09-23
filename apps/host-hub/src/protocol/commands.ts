// 对外命令面（DESIGN §3，60 个）：wire 入参的松类型（解析与校验在处理器逐字段做）。
// 本文件持命令名封闭集与共享入参形状；分组仅作文档注记——路由事实在 internal.ts。
import type { WireImage } from "../shared/images.ts";

export interface CommandInput {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface ThreadStartSpec {
  cwd?: string;
  provider?: string;
  modelId?: string;
  trusted?: boolean;
  permissionMode?: string;
  thinkingLevel?: string;
}

export interface PromptSpec {
  threadId: string;
  message: string;
  images?: WireImage[];
  streamingBehavior?: "steer" | "followUp";
}

export interface SteerSpec {
  threadId: string;
  message: string;
  images?: WireImage[];
}

export interface EntriesQuery {
  threadId: string;
  since?: number;
  before?: number;
  limit?: number;
}

export interface ForkSpec {
  threadId: string;
  seq: number;
  position?: "before" | "at";
}

export interface BashSpec {
  threadId: string;
  command: string;
  timeoutMs?: number;
  excludeFromContext?: boolean;
  id?: string;
}

/** 全命令名封闭集（smoke 断言依据；新增命令必须先进本表） */
export const COMMAND_NAMES: readonly string[] = [
  "thread/start",
  "thread/resume",
  "thread/register",
  "thread/stop",
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
  "set_session_name",
  "get_commands",
  "get_fork_messages",
  "get_subagents",
  "get_pending_dialogs",
  "fork",
  "clone",
  "get_models",
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
  "get_host_info",
  "set_idle_retire_ms",
  "set_rss_retire_bytes",
  "workspace/trust",
  "thread/delete",
] as const;

export function isKnownCommand(type: string): boolean {
  return COMMAND_NAMES.includes(type);
}
