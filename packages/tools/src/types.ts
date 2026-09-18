// Tools 契约类型（docs/TOOLS.md §1.1）：结果即返回值（pi 思想）——concludesTurn/additionalContexts
// 进 outcome，不做 exec 上的方法调用；additionalContexts 仅 text 块（tool_use 会被适配器丢弃）。

import type { Static, TSchema } from "@sinclair/typebox";
import type { ContentBlock } from "@x-harness/session";

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
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolOutcome>;
}

/** 泛型助手（pi 的 defineTool 思想）：保持 Static<T> 参数推断——execute 拿到类型安全的已校验参数 */
export function defineTool<T extends TSchema>(def: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: T;
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  execute(args: Static<T>, ctx: ToolExecContext): Promise<ToolOutcome>;
}): ToolDefinition {
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    inputSchema: def.inputSchema,
    ...(def.isConcurrencySafe !== undefined ? { isConcurrencySafe: def.isConcurrencySafe } : {}),
    // 运行时收到的是经 TypeBox 校验的值；静态收窄由本助手的泛型保证
    execute: def.execute as ToolDefinition["execute"],
  };
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
}

export type PreExecuteDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

export interface ToolRegistry {
  /** 重名注册 throw；运行期注册新名合法（schemas 即时反映）；Disposer 由注册方自行绑定 ctx.effect */
  register(def: ToolDefinition): () => void;
  get(name: string): ToolDefinition | undefined;
  schemas(): readonly ToolSchema[];
  concurrencyOf(name: string, args: unknown): "parallel" | "exclusive";
  dispatch(request: ToolCallRequest): Promise<ToolOutcome>;
}
