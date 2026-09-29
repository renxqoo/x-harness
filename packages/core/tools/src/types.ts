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
  readonly session?: SessionId;
  readonly onOutput?: (delta: string) => void;
  readonly exec?: "direct" | "contained";
  readonly escalatable?: true;
}

export interface ToolOutcome {
  readonly content: string;
  readonly isError?: true;
  readonly aborted?: true;
  readonly concludesTurn?: true;
  readonly additionalContexts?: readonly { readonly content: readonly TextBlock[] }[];
}

export type ToolKind = "Read" | "Write" | "Danger";

export interface ToolDefinition extends ToolSchema {
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  readonly isControlTool?: true;
  readonly kind?: ToolKind;
  readonly readsSubtree?: true | ((args: unknown) => boolean);
  readonly guidance?: string;
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolOutcome>;
}

export function defineTool<T extends TSchema>(def: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: T;
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  readonly isControlTool?: true;
  readonly kind?: ToolKind;
  readonly readsSubtree?: true | ((args: unknown) => boolean);
  execute(args: Static<T>, ctx: ToolExecContext): Promise<ToolOutcome>;
}): ToolDefinition {
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    inputSchema: def.inputSchema,
    ...(def.isConcurrencySafe !== undefined ? { isConcurrencySafe: def.isConcurrencySafe } : {}),
    ...(def.isControlTool !== undefined ? { isControlTool: def.isControlTool } : {}),
    ...(def.kind !== undefined ? { kind: def.kind } : {}),
    ...(def.readsSubtree !== undefined ? { readsSubtree: def.readsSubtree } : {}),
    execute: def.execute as ToolDefinition["execute"],
  };
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
  readonly session?: SessionId;
  readonly onOutput?: (delta: string) => void;
}

export type PreExecuteDecision =
  | { readonly kind: "allow"; readonly exec?: "direct" | "contained"; readonly escalatable?: true }
  | { readonly kind: "deny"; readonly reason: string };

export type ToolFilter = readonly string[] | "deny-all";

export interface ToolRegistry {
  register(def: ToolDefinition): () => void;
  get(name: string): ToolDefinition | undefined;
  schemas(options?: { readonly sessionId?: string }): readonly ToolSchema[];
  scoped(sessionId: string): { restrict(filter: ToolFilter): () => void };
  restrictionOf(sessionId: string): ToolFilter | undefined;
  concurrencyOf(name: string, args: unknown): "parallel" | "exclusive";
  dispatch(request: ToolCallRequest): Promise<ToolOutcome>;
}
