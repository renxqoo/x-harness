// workflow 命令面（件16 期 3 不经模型——worker 侧 handler：list 盘读 / submit·stop 经
// workflowView 与 task_stop 协议链）。从 worker-commands 抽出（行数纪律）。

import { hubError } from "../shared/errors.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import type { SessionId } from "@x-harness/session";

/** 适配形态（worker-commands 的 respond/requireThread 原签名——不自造中间接口） */
interface WorkflowDeps {
  readonly rt: unknown;
  readonly respond: (frame: { readonly id: string | undefined; readonly command: string; data?: unknown; error?: HubErrorShape }) => void;
  readonly requireThread: (rt: unknown, input: { readonly command: string }) => { readonly id: SessionId } | undefined;
}



type RespondFn = (frame: { readonly id: string | undefined; readonly command: string; data?: unknown; error?: HubErrorShape }) => void;

/** submit 参数构造（input → SubmitInput——复杂度纪律抽出） */
function submitInputOf(input: { readonly [key: string]: unknown }, schema: unknown): import("@x-harness/agent-workflow").SubmitInput {
  return {
    description: typeof input.description === "string" ? input.description : "task",
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    ...(schema !== undefined && schema !== null ? { result_schema: schema } : {}),
    ...(typeof input.verifyCommand === "string" && input.verifyCommand !== "" ? { acceptance: { command: input.verifyCommand } } : {}),
  };
}

/** workflow/submit 的 schema 字符串解析（坏 JSON → 错误响应 + null） */
function safeJson(plan: { readonly raw: string; readonly id: string | undefined; readonly respond: RespondFn }): unknown | null {
  try {
    return JSON.parse(plan.raw) as unknown;
  } catch (error) {
    plan.respond({ id: plan.id, command: "workflow/submit", error: hubError("invalid_input", `resultSchema JSON invalid: ${error instanceof Error ? error.message : String(error)}`) });
    return null;
  }
}

export function createWorkflowHandlers(deps: WorkflowDeps): ReadonlyArray<readonly [string, (input: { id?: unknown; [key: string]: unknown }) => Promise<void>]> {
  return [
    ["workflow/list", async (input) => {
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { resolveWorkflowRoot } = await import("@x-harness/agent-workflow");
      const root = resolveWorkflowRoot(undefined, process.env);
      const runs: Array<{ runId: string; status: string; lastEvent: string }> = [];
      for (const runId of await readdir(root).catch(() => [] as string[])) {
        const raw = await readFile(join(root, runId, "journal.jsonl"), "utf8").catch(() => "");
        if (raw === "") continue;
        const events = raw.split("\n").filter((l) => l !== "").map((l) => { try { return JSON.parse(l) as { type: string }; } catch { return { type: "?" }; } });
        const settled = events.some((e) => e.type === "run/settled");
        runs.push({ runId, status: settled ? "settled" : "in-flight", lastEvent: events[events.length - 1]?.type ?? "?" });
      }
      deps.respond({ id: typeof input.id === "string" ? input.id : undefined, command: "workflow/list", data: { runs } });
    }],
    ["workflow/submit", async (input) => {
      const session = deps.requireThread(deps.rt, { command: "workflow/submit" });
      if (session === undefined) return;
      const world = (deps.rt as { state: { world?: { ctx: import("@x-harness/core").Context } } }).state.world;
      const view = world?.ctx.tryUse((await import("@x-harness/agent-workflow")).workflowView);
      const id = typeof input.id === "string" ? input.id : undefined;
      if (view === undefined) {
        deps.respond({ id, command: "workflow/submit", error: hubError("unknown_command", "workflow is not assembled in this build") });
        return;
      }
      const respondOne: RespondFn = (frame) => deps.respond(frame);
      const schemaRaw = typeof input.resultSchema === "string" && input.resultSchema !== "" ? input.resultSchema : undefined;
      const schema = schemaRaw !== undefined ? safeJson({ raw: schemaRaw, id, respond: respondOne }) : undefined;
      if (schemaRaw !== undefined && schema === null) return; // 坏 JSON 已应答
      const made = await view.submit(session.id, submitInputOf(input, schema));
      if (!made.ok) {
        deps.respond({ id, command: "workflow/submit", error: hubError("invalid_input", made.reason) });
        return;
      }
      deps.respond({ id, command: "workflow/submit", data: { text: made.text } });
    }],
    ["workflow/stop", async (input) => {
      const session = deps.requireThread(deps.rt, { command: "workflow/stop" });
      if (session === undefined) return;
      const id = typeof input.id === "string" ? input.id : undefined;
      const taskId = typeof input.taskId === "string" ? input.taskId : "";
      if (taskId === "") {
        deps.respond({ id, command: "workflow/stop", error: hubError("invalid_input", "taskId required") });
        return;
      }
      const world = (deps.rt as { state: { world?: { ctx: import("@x-harness/core").Context } } }).state.world;
      const registry = world?.ctx.tryUse((await import("@x-harness/tools")).toolRegistry);
      if (registry === undefined) {
        deps.respond({ id, command: "workflow/stop", error: hubError("unknown_command", "tool registry unavailable") });
        return;
      }
      const made = await registry.dispatch({ callId: `wf-stop-${String(id ?? "x")}`, name: "task_stop", args: { task_id: taskId }, signal: new AbortController().signal, session: session.id });
      deps.respond({ id, command: "workflow/stop", ...(made.isError === true ? { error: hubError("invalid_input", String(made.content)) } : { data: { text: String(made.content) } }) });
    }],
  ];
}