import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentLoop, streamAgent } from "../../plugins/agent-loop/src/index";
import type { AgentCheckpoint, AgentEvent, AgentRun } from "../../plugins/agent-loop/src/index";
import { session } from "../../plugins/session/src/index";
import { toolScheduler } from "../../plugins/tool-scheduler/src/index";
import { openJourneyHost } from "./open-journey-host";
import { requireValue } from "./require-value";
import type { JourneyOptions, JourneyState } from "./types";

export async function verifyJourney(options: JourneyOptions) {
  const started = performance.now();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "xh-agent-journey-")));
  const state: JourneyState = { directory, total: 1530, receipt: crypto.randomUUID(), calls: [], checkpoints: [], hosts: [] };
  const events: AgentEvent[] = [];
  const answer = (run: AgentRun) => run.response.content.filter(block => block.block.kind === "text" && block.status === "complete").map(block => block.text ?? "").join("");
  const verifyAnswer = (run: AgentRun) => {
    let parsed: unknown;
    try { parsed = JSON.parse(answer(run)); } catch { throw new Error("Agent final answer is not a visible JSON report"); }
    if (run.stopReason !== "model" || run.response.reason.kind !== "stop" || !isDeepStrictEqual(parsed, { total: state.total, receipt: state.receipt })) throw new Error("Agent final answer lost the verified total or receipt");
  };
  try {
    await writeFile(join(directory, "invoice.json"), JSON.stringify({ items: [{ unitPrice: 173, quantity: 7 }, { unitPrice: 89, quantity: 5 }], discount: 126, receipt: state.receipt }));
    await writeFile(join(directory, "calculate.mjs"), 'import {readFileSync,writeFileSync} from "node:fs"; const invoice=JSON.parse(readFileSync("invoice.json","utf8")); const report={total:invoice.items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0)-invoice.discount,receipt:invoice.receipt}; const text=JSON.stringify(report); writeFileSync("calculation.json",text); process.stdout.write(text);');
    const host = await openJourneyHost(options, state);
    requireValue(await requireValue(host.use(session)).create({ id: "invoice" }));
    const stream = streamAgent(requireValue(host.use(agentLoop)), {
      model: options.model, maxOutputTokens: 2048, timeoutMs: 300000, ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      messages: [{ role: "user", content: [{ type: "text", text: "Complete this invoice workflow using the tools, one action per round. First call read_report. If it is missing, recover by calling read_invoice, then calculate_invoice, then save_report with the exact calculator result, then read_report to verify the persisted file. Call calculate_invoice and save_report exactly once. Do not calculate manually. After the final verification, answer only with the exact JSON object containing total (integer cents) and receipt (exact string). No Markdown or explanation. Do not stop before verification." }] }],
    });
    for await (const event of stream) { events.push(event); if (event.type === "step-start") options.onStep?.(event.step); }
    const outcome = await stream.result;
    if (!outcome.ok) throw new Error(JSON.stringify({ error: outcome.error, modelErrors: events.flatMap(event => event.type === "model-event" && event.event.type === "error" ? [event.event.error] : []) }));
    const completed = outcome.value;
    verifyAnswer(completed);
    const writes = state.calls.filter(name => name === "save_report").length;
    if (writes !== 1 || state.calls.filter(name => name === "calculate_invoice").length !== 1 || state.calls[0] !== "read_report" || state.calls.at(-1) !== "read_report") throw new Error("Agent skipped verification or repeated a side effect");
    let position = -1;
    for (const name of ["read_report", "read_invoice", "calculate_invoice", "save_report", "read_report"]) {
      position = state.calls.indexOf(name, position + 1);
      if (position < 0) throw new Error("Agent skipped a dependent workflow step");
    }
    if (!isDeepStrictEqual(JSON.parse(await readFile(join(directory, "report.json"), "utf8")), { total: state.total, receipt: state.receipt })) throw new Error("Persisted invoice report differs from the calculator result");
    if (completed.steps < 5 || completed.toolCalls !== state.calls.length || events.some((event, index) => event.sequence !== index) || events.filter(event => event.type === "finish").length !== 1 || events.at(-1)?.type !== "finish" || !events.some(event => event.type === "tool-progress") || !events.some(event => event.type === "model-event" && event.event.type === "text-delta")) throw new Error("Agent streaming lifecycle or step accounting is incomplete");
    if (completed.messages.find(message => message.role === "tool")?.isError !== true) throw new Error("Missing report error was not preserved in the transcript");
    const scheduler = requireValue(await requireValue(host.use(toolScheduler)).inspect({}));
    if (scheduler.running || scheduler.queued || scheduler.requests) throw new Error("Tool scheduler retained completed work");
    const checkpointCount = state.checkpoints.length;
    requireValue(await host.close());
    const reopened = await openJourneyHost(options, state);
    const storage = requireValue(reopened.use(session));
    const records = [];
    let after: number | undefined;
    do {
      const page = requireValue(await storage.history({ id: "invoice", limit: 100, ...(after ? { after } : {}) }));
      records.push(...page.records);
      after = page.next;
    } while (after);
    const durable = records.map(record => record.entry.kind === "event" ? record.entry.data as unknown as AgentCheckpoint : undefined);
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(durable)), JSON.parse(JSON.stringify(state.checkpoints))) || records.length !== checkpointCount) throw new Error("SQLite reopen lost or changed Agent checkpoints");
    const latest = durable.at(-1);
    if (!latest || latest.phase !== "response" || latest.response.reason.kind !== "stop" || !isDeepStrictEqual(JSON.parse(JSON.stringify(latest.messages)), JSON.parse(JSON.stringify(completed.messages)))) throw new Error("Final durable checkpoint cannot safely resume");
    const callsBeforeResume = state.calls.length;
    const resumed = requireValue(await requireValue(reopened.use(agentLoop)).run({ model: options.model, tools: [], maxOutputTokens: 512, ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}), messages: [...latest.messages, { role: "user", content: [{ type: "text", text: "From the completed workflow in the history, repeat only the exact JSON object containing total (integer cents) and receipt (exact string). No Markdown or explanation. Do not perform any actions." }] }] }));
    verifyAnswer(resumed);
    if (resumed.steps !== 1 || resumed.toolCalls !== 0 || state.calls.length !== callsBeforeResume) throw new Error("Explicit resume replayed completed tools");
    requireValue(await reopened.close());
    for (const closed of state.hosts) {
      const inspection = closed.inspect();
      if (inspection.activeCalls || inspection.activeTasks || inspection.resources.length) throw new Error("Closed Agent host retained active work or resources");
    }
    return { ok: true, model: options.model, ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}), steps: completed.steps, toolCalls: completed.toolCalls, calls: state.calls, events: events.length, checkpoints: checkpointCount, resumedSteps: resumed.steps, resumedToolCalls: resumed.toolCalls, usage: completed.usage, resumedUsage: resumed.usage, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    try {
      const closed = await Promise.all(state.hosts.map(host => host.close()));
      for (const result of closed) requireValue(result);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
