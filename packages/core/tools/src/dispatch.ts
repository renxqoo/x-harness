import { errorText } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
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
      return "<unprintable thrown value>";
    }
  }
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

function gateDecision(value: unknown): PreExecuteDecision {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["kind"] === "allow") {
      const exec = record["exec"];
      const escalatable = record["escalatable"];
      if (exec !== undefined && exec !== "direct" && exec !== "contained") return { kind: "deny", reason: "invalid-decision" };
      if (escalatable !== undefined && escalatable !== true) return { kind: "deny", reason: "invalid-decision" };
      return {
        kind: "allow",
        ...(exec !== undefined ? { exec: exec as "direct" | "contained" } : {}),
        ...(escalatable !== undefined ? { escalatable: true } : {}),
      };
    }
    if (record["kind"] === "deny" && (record["reason"] === undefined || typeof record["reason"] === "string")) {
      return { kind: "deny", reason: typeof record["reason"] === "string" ? record["reason"] : "" };
    }
  }
  return { kind: "deny", reason: "invalid-decision" };
}

function flagsValid(record: Record<string, unknown>): boolean {
  for (const flag of ["isError", "aborted", "concludesTurn"] as const) {
    if (record[flag] !== undefined && record[flag] !== true) return false;
  }
  return true;
}

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

function gateOutcome(raw: unknown): ToolOutcome {
  const invalid = (): ToolOutcome => errorOutcome("invalid-tool-output");
  if (typeof raw !== "object" || raw === null) return invalid();
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (typeof record["content"] !== "string") return invalid();
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

async function runBody(
  tool: ToolDefinition,
  request: ToolCallRequest,
  allow?: { readonly exec?: "direct" | "contained"; readonly escalatable?: true },
): Promise<ToolOutcome> {
  let raw: unknown;
  try {
    raw = await tool.execute(request.args, {
      callId: request.callId,
      name: request.name,
      signal: request.signal,
      ...(request.session !== undefined ? { session: request.session } : {}),
      ...(request.onOutput !== undefined ? { onOutput: request.onOutput } : {}),
      ...(allow?.exec !== undefined ? { exec: allow.exec } : {}),
      ...(allow?.escalatable !== undefined ? { escalatable: true } : {}),
    });
  } catch (error) {
    if (request.signal.aborted) return abortedOutcome();
    return errorOutcome(normalizeThrown(error));
  }
  if (request.signal.aborted) return abortedOutcome();
  return gateOutcome(raw);
}

function isScopeRead(tool: ToolDefinition, args: unknown): boolean {
  if (tool.readsSubtree === true) return true;
  return typeof tool.readsSubtree === "function" && tool.readsSubtree(args) === true;
}

function preExecutePayload(tool: ToolDefinition, request: ToolCallRequest): {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly control?: true;
  readonly kind?: string;
  readonly readsSubtree?: true;
  readonly session?: SessionId;
} {
  return {
    callId: request.callId,
    name: request.name,
    args: request.args,
    ...(tool.isControlTool === true ? { control: true } : {}),
    ...(tool.kind !== undefined ? { kind: tool.kind } : {}),
    ...(isScopeRead(tool, request.args) ? { readsSubtree: true } : {}),
    ...(request.session !== undefined ? { session: request.session } : {}),
  };
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
      const decision = gateDecision(
        await deps.dispatchPreExecute(preExecutePayload(tool, request)),
      );
      if (decision.kind === "deny") return errorOutcome(`denied:${decision.reason}`);
      if (request.signal.aborted) return abortedOutcome();
      const violations = violationsOf(tool.inputSchema, request.args);
      if (violations !== undefined) {
        return errorOutcome(`${violations}\nreceived: ${formatArgsEcho(request.args)}`);
      }
      return await deps.dispatchExecute(request, async (req) => {
        if (req.args !== request.args || req.name !== request.name || req.callId !== request.callId || req.session !== request.session) {
          return errorOutcome("request-altered");
        }
        return runBody(tool, req, decision.kind === "allow" ? decision : undefined);
      });
    } catch (error) {
      return errorOutcome(`internal:${errorText(error)}`);
    }
  };
}
