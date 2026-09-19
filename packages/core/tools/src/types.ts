// Tools 契约类型（docs/TOOLS.md §1.1）：结果即返回值（pi 思想）——concludesTurn/additionalContexts
// 进 outcome，不做 exec 上的方法调用；additionalContexts 仅 text 块（tool_use 会被适配器丢弃）。

import type { Static, TSchema } from "@sinclair/typebox";
import type { ContentBlock, SessionId } from "@x-harness/session";

export type TextBlock = Extract<ContentBlock, { readonly type: "text" }>;

export interface ToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: TSchema;
}

export interface ToolExecContext {
  readonly callId: string;
  readonly name: string;
  readonly signal: AbortSignal;
  /** 调用方会话（agent 调度携带）——工具识别父/血缘寻址 */
  readonly session?: SessionId;
}

export interface ToolOutcome {
  readonly content: string;
  readonly isError?: true;
  /** 结构化判别：loop 据此区分 abort 双码（超时/用户取消） */
  readonly aborted?: true;
  /** 工具显式终结 turn（易失：不进任何 session 事件——repair 后丢失是已知语义） */
  readonly concludesTurn?: true;
  readonly additionalContexts?: readonly { readonly content: readonly TextBlock[] }[];
}

export interface ToolDefinition extends ToolSchema {
  /** 严格 true 才可并行（缺省/抛错/非 true 一律 exclusive——fail-closed） */
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  /** 控制类工具（Codex is_builtin_control_tool 同构语义）：agent 自我组织/控制面行为，
   *  非环境副作用——permission 裁决面直通（声明权在工具定义，安全面只认标记不认名单） */
  readonly isControlTool?: true;
  /** 使用守则（纯数据）：工具在场才成立的行事约束——经 tool-core 工厂参数投稿为
   *  system-prompt 段（D3；make() 自带此字段仅作数据不触发停靠——W1 审查 L-1 记录）。
   *  不进 LLM 序列化（schemas() 显式子集映射，guidance 不外漏） */
  readonly guidance?: string;
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolOutcome>;
}

/** 泛型助手（pi 的 defineTool 思想）：保持 Static<T> 参数推断——execute 拿到类型安全的已校验参数 */
export function defineTool<T extends TSchema>(def: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: T;
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  readonly isControlTool?: true;
  execute(args: Static<T>, ctx: ToolExecContext): Promise<ToolOutcome>;
}): ToolDefinition {
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    inputSchema: def.inputSchema,
    ...(def.isConcurrencySafe !== undefined ? { isConcurrencySafe: def.isConcurrencySafe } : {}),
    ...(def.isControlTool !== undefined ? { isControlTool: def.isControlTool } : {}),
    // 运行时收到的是经 TypeBox 校验的值；静态收窄由本助手的泛型保证
    execute: def.execute as ToolDefinition["execute"],
  };
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
  /** 归属会话（agent 调度携带）：语义持久检查点据此 flush；缺省=非 agent 调用方 */
  readonly session?: SessionId;
}

export type PreExecuteDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

/** 会话层工具收窄：可见名白名单或 "deny-all"（全禁） */
export type ToolFilter = readonly string[] | "deny-all";

export interface ToolRegistry {
  /** 重名注册 throw；运行期注册新名合法（schemas 即时反映）；Disposer 由注册方自行绑定 ctx.effect */
  register(def: ToolDefinition): () => void;
  get(name: string): ToolDefinition | undefined;
  /** 分层投影：根层 − 该会话 restriction（缺省参会话无关 = 全量，向后兼容——ELEVATION-DESIGN §2.2）。
   *  只投影不执行门禁的孪生执法面在 agent-loop（allowedTools 喂投影名集） */
  schemas(options?: { readonly sessionId?: string }): readonly ToolSchema[];
  /** 会话层收窄写入面（X15 沿树只收窄）；同会话二次 restrict 覆盖（身份守卫）。
   *  生命周期：sessionDisposed 自动注销（toolsPlugin 挂），或 disposer 手动 */
  scoped(sessionId: string): { restrict(filter: ToolFilter): () => void };
  /** 读回：该会话当前生效 restriction（无 = 未收窄）——delegation 血缘收窄的输入源（W2A） */
  restrictionOf(sessionId: string): ToolFilter | undefined;
  concurrencyOf(name: string, args: unknown): "parallel" | "exclusive";
  dispatch(request: ToolCallRequest): Promise<ToolOutcome>;
}
