// 执行管线（docs/TOOLS.md §1.3）：形状守卫 → abort → lookup → pre-execute → abort 复查 →
// TypeBox 校验 → execute waterfall → 归一化。函数体整体 try/catch——dispatch 永不 reject。

import { errorText } from "@x-harness/core";
import type { PreExecuteDecision, ToolCallRequest, ToolDefinition, ToolOutcome, ToolRegistry } from "./types.ts";
import { formatArgsEcho, violationsOf } from "./validate.ts";

export interface DispatcherDeps {
  readonly registry: Omit<ToolRegistry, "dispatch">;
  readonly dispatchPreExecute: (payload: { readonly callId: string; readonly name: string; readonly args: unknown }) => Promise<PreExecuteDecision>;
  readonly dispatchExecute: (
    request: ToolCallRequest,
    final: (request: ToolCallRequest) => Promise<ToolOutcome>,
  ) => Promise<ToolOutcome>;
}

function errorOutcome(content: string): ToolOutcome {
  return { content, isError: true };
}

function abortedOutcome(): ToolOutcome {
  return { content: "aborted", isError: true, aborted: true };
}

function normalizeThrown(error: unknown): string {
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      return "<unprintable thrown value>"; // hostile message getter
    }
  }
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

/** 决策形状门：非判别形态 → deny invalid-decision（fail-closed） */
function gateDecision(value: unknown): PreExecuteDecision {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["kind"] === "allow") return { kind: "allow" };
    if (record["kind"] === "deny" && (record["reason"] === undefined || typeof record["reason"] === "string")) {
      return { kind: "deny", reason: typeof record["reason"] === "string" ? record["reason"] : "" };
    }
  }
  return { kind: "deny", reason: "invalid-decision" };
}

/** 三布尔标志：出现即必须为 true（显式 false 是契约错误——与 session 词表同口径） */
function flagsValid(record: Record<string, unknown>): boolean {
  for (const flag of ["isError", "aborted", "concludesTurn"] as const) {
    if (record[flag] !== undefined && record[flag] !== true) return false;
  }
  return true;
}

/** additionalContexts：数组的数组的纯 text 块（tool_use 会被适配器丢弃，直接拒） */
function contextsValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !Array.isArray((entry as Record<string, unknown>)["content"])) {
      return false;
    }
    for (const block of (entry as { content: unknown[] }).content) {
      const b = block as Record<string, unknown>;
      if (b?.["type"] !== "text" || typeof b["text"] !== "string") return false;
    }
  }
  return true;
}

/** outcome 形状门：白名单字段构造（未知字段放行不拒），任何契约违规 → invalid-tool-output */
function gateOutcome(raw: unknown): ToolOutcome {
  const invalid = (): ToolOutcome => errorOutcome("invalid-tool-output");
  if (typeof raw !== "object" || raw === null) return invalid();
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (typeof record["content"] !== "string") return invalid(); // hostile content getter 也归位于此
    if (!flagsValid(record)) return invalid();
    if (record["additionalContexts"] !== undefined && !contextsValid(record["additionalContexts"])) return invalid();
  } catch {
    return invalid();
  }
  return {
    content: record["content"],
    ...(record["isError"] === true ? { isError: true } : {}),
    ...(record["aborted"] === true ? { aborted: true } : {}),
    ...(record["concludesTurn"] === true ? { concludesTurn: true } : {}),
    ...(record["additionalContexts"] !== undefined
      ? { additionalContexts: record["additionalContexts"] as ToolOutcome["additionalContexts"] }
      : {}),
  };
}

async function runBody(tool: ToolDefinition, request: ToolCallRequest): Promise<ToolOutcome> {
  let raw: unknown;
  try {
    raw = await tool.execute(request.args, { callId: request.callId, name: request.name, signal: request.signal });
  } catch (error) {
    if (request.signal.aborted) return abortedOutcome();
    return errorOutcome(normalizeThrown(error));
  }
  if (request.signal.aborted) return abortedOutcome(); // success superseded：执行后取消，结果不可信
  return gateOutcome(raw);
}

export function createDispatcher(deps: DispatcherDeps): ToolRegistry["dispatch"] {
  return async (request: ToolCallRequest): Promise<ToolOutcome> => {
    try {
      if (
        typeof request?.name !== "string" ||
        typeof request?.callId !== "string" ||
        typeof request?.signal?.throwIfAborted !== "function"
      ) {
        return errorOutcome("invalid-request");
      }
      if (request.signal.aborted) return abortedOutcome();
      const tool = deps.registry.get(request.name);
      if (tool === undefined) return errorOutcome(`unknown-tool:${request.name}`);
      const decision = gateDecision(await deps.dispatchPreExecute({ callId: request.callId, name: request.name, args: request.args }));
      if (decision.kind === "deny") return errorOutcome(`denied:${decision.reason}`);
      if (request.signal.aborted) return abortedOutcome();
      const violations = violationsOf(tool.inputSchema, request.args);
      if (violations !== undefined) {
        return errorOutcome(`${violations}\nreceived: ${formatArgsEcho(request.args)}`);
      }
      return await deps.dispatchExecute(request, async (req) => {
        // 中间件可换 signal（超时/取消包裹）；args/name/callId 不可换——替换即击穿校验先行的契约
        if (req.args !== request.args || req.name !== request.name || req.callId !== request.callId || req.session !== request.session) {
          return errorOutcome("request-altered");
        }
        return runBody(tool, req);
      });
    } catch (error) {
      // 逃逸 throw（中间件 bug/内核层回卷/垃圾输入）：归一化为模型可读结果，dispatch 永不 reject
      return errorOutcome(`internal:${errorText(error)}`);
    }
  };
}
