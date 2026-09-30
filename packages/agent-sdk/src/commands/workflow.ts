import type { Session, SessionId } from "@x-harness/session";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkflowRoot, workflowView } from "@x-harness/agent-workflow";
import type { SubmitInput } from "@x-harness/agent-workflow";
import { toolRegistry } from "@x-harness/tools";
import { hubError } from "../shared/errors.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface WorkflowCommandState {
  session: Session | undefined;
  env: Record<string, string | undefined>;
  workflowRoot?: string;
  world: { tryUse(token: unknown): unknown } | undefined;
}

function noThread(command: string): CommandOutcome {
  return { command, error: hubError("unknown_thread", "Unknown threadId") };
}

export async function workflowList(state: WorkflowCommandState): Promise<CommandOutcome> {
  const root = resolveWorkflowRoot(state.workflowRoot, state.env);
  const runs: Array<{ runId: string; status: string; lastEvent: string }> = [];
  for (const runId of await readdir(root).catch(() => [] as string[])) {
    const raw = await readFile(join(root, runId, "journal.jsonl"), "utf8").catch(() => "");
    if (raw === "") continue;
    const events = raw.split("\n").filter((l) => l !== "").map((l) => {
      try {
        return JSON.parse(l) as { type: string };
      } catch {
        return { type: "?" };
      }
    });
    const settled = events.some((e) => e.type === "run/settled");
    runs.push({ runId, status: settled ? "settled" : "in-flight", lastEvent: events[events.length - 1]?.type ?? "?" });
  }
  return { command: "workflow/list", data: { runs } };
}

function submitInputOf(input: Record<string, unknown>, schema: unknown): SubmitInput {
  return {
    description: typeof input.description === "string" ? input.description : "task",
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    ...(schema !== undefined && schema !== null ? { result_schema: schema } : {}),
    ...(typeof input.verifyCommand === "string" && input.verifyCommand !== "" ? { acceptance: { command: input.verifyCommand } } : {}),
  };
}

function parseSchema(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function workflowSubmit(state: WorkflowCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return noThread("workflow/submit");
  const view = state.world?.tryUse(workflowView) as { submit(id: SessionId, input: SubmitInput): Promise<{ ok: true; text: string } | { ok: false; reason: string }> } | undefined;
  if (view === undefined) return { command: "workflow/submit", error: hubError("unknown_command", "workflow is not assembled in this build") };
  const schemaRaw = typeof input.resultSchema === "string" && input.resultSchema !== "" ? input.resultSchema : undefined;
  const schema = schemaRaw !== undefined ? parseSchema(schemaRaw) : undefined;
  if (schema !== undefined && !schema.ok) {
    return { command: "workflow/submit", error: hubError("invalid_input", `resultSchema JSON invalid: ${schemaRaw}`) };
  }
  const made = await view.submit(session.id, submitInputOf(input, schema !== undefined && schema.ok ? schema.value : undefined));
  if (!made.ok) return { command: "workflow/submit", error: hubError("invalid_input", made.reason) };
  return { command: "workflow/submit", data: { text: made.text } };
}

export async function workflowStop(state: WorkflowCommandState, input: Record<string, unknown>, requestId?: string): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return noThread("workflow/stop");
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  if (taskId === "") return { command: "workflow/stop", error: hubError("invalid_input", "taskId required") };
  const registry = state.world?.tryUse(toolRegistry) as { dispatch(spec: { callId: string; name: string; args: Record<string, unknown>; signal: AbortSignal; session: SessionId }): Promise<{ isError: boolean; content: unknown }> } | undefined;
  if (registry === undefined) return { command: "workflow/stop", error: hubError("unknown_command", "tool registry unavailable") };
  const made = await registry.dispatch({ callId: `wf-stop-${String(requestId ?? "x")}`, name: "task_stop", args: { task_id: taskId }, signal: new AbortController().signal, session: session.id });
  return made.isError === true
    ? { command: "workflow/stop", error: hubError("invalid_input", String(made.content)) }
    : { command: "workflow/stop", data: { text: String(made.content) } };
}
