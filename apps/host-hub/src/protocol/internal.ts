// host↔worker 私有协议（DESIGN §4/§7）：hello 首帧握手、心跳真相、命令域划分。
// 线程域命令集（host 逐字路由给 worker）与观察者集（不重置 idle）是路由纪律的
// 单一事实；internal id 命名空间不可与客户端 id 碰撞。
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_BACKEND_ID = "x-harness";
/** internal id 前缀：显式命名空间——客户端 id 空间不受约束也不可碰撞
 *  （成员关系判定 + 不可伪造形态） */
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

/** 线程域命令（host 逐字转发 worker；其余命令 host 本地应答）——start/resume/stop
 *  在 worker 执行（会话的建立与回收是 worker 侧事实；host 做准入/占用/预算） */
export const THREAD_SCOPED_COMMANDS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/resume",
  "thread/stop",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
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
  "set_model",
  "bash",
  "abort_bash",
  "subagent/steer",
  "set_thinking_level",
  "get_thinking_level",
]);

/** host 单点注册但带 threadId 形态交池转发的命令（DESIGN §3.9——处理在 worker，
 *  host 持无 threadId 的全局形态；routeLine 的线程域判定 = THREAD_SCOPED ∪ 本集） */
export const HOST_RELAYED_THREAD_COMMANDS: ReadonlySet<string> = new Set(["permission/set_mode", "permission/get_mode"]);

/** 观察者命令：不重置 worker idle 计时（轮询客户端不阻止收编）——worker 侧清单 */
export const OBSERVER_COMMANDS: ReadonlySet<string> = new Set([
  "get_state",
  "get_inflight",
  "get_messages",
  "get_entries",
  "get_tree",
  "get_session_stats",
  "get_commands",
  "get_fork_messages",
  "get_subagents",
  "get_pending_dialogs",
  "get_thinking_level",
  "permission/get_mode",
]);

/** 驱动命令：受理后必有恰一 settled（sendId = 命令 id）——host 据此登记在飞 */
export const DRIVING_COMMANDS: ReadonlySet<string> = new Set(["prompt", "steer", "follow_up"]);

/** 触发会话替换/线程控制的命令（worker 侧执行期校验线程一致性） */
export function isThreadScoped(command: string): boolean {
  return THREAD_SCOPED_COMMANDS.has(command);
}

export function isInternalId(id: string): boolean {
  return id.startsWith(INTERNAL_ID_PREFIX);
}
