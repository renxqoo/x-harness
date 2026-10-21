import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createToolPlugin } from "../../plugins/tools/src/index";
import { requireValue } from "./require-value";
import type { JourneyState } from "./types";

export function createJourneyTools(state: JourneyState) {
  const output = (text: string, isError = false) => ({ ok: true as const, value: { content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) } });
  const empty = { type: "object", additionalProperties: false } as const;
  const resource = (file: string, mode: "read" | "write") => ({ domain: "filesystem", path: join(state.directory, file).split("/").filter(Boolean), scope: "exact" as const, mode });
  return [
    requireValue(createToolPlugin({
      name: "read_invoice", description: "Read the source invoice. Call before calculate_invoice.", inputSchema: empty,
      async prepare() { return { ok: true, value: { actions: { read: "invoice" }, resources: [resource("invoice.json", "read")] } }; },
      async execute() { state.calls.push("read_invoice"); return output(await readFile(join(state.directory, "invoice.json"), "utf8")); },
    })),
    requireValue(createToolPlugin({
      name: "calculate_invoice", description: "Run the trusted invoice calculator process. Returns total and receipt required by save_report.", inputSchema: empty,
      async prepare() { return { ok: true, value: { actions: { calculate: true }, execution: { profile: "invoice", argv: [process.execPath, join(state.directory, "calculate.mjs")] } } }; },
      async execute(_input, call) {
        state.calls.push("calculate_invoice");
        if (!call.execution) return output("Calculator unavailable", true);
        const progress = await call.progress("Calculating invoice in a child process");
        if (!progress.ok) return progress;
        const result = await call.execution.run();
        if (!result.ok) return output("Calculator failed", true);
        return output(result.value.stdout, result.value.exitCode !== 0);
      },
    })),
    requireValue(createToolPlugin({
      name: "save_report", description: "Save the exact total and receipt returned by calculate_invoice.",
      inputSchema: { type: "object", properties: { total: { type: "integer", minimum: 0 }, receipt: { type: "string", maxLength: 100 } }, required: ["total", "receipt"], additionalProperties: false },
      async prepare() { return { ok: true, value: { actions: { write: "report" }, resources: [resource("report.json", "write"), resource("calculation.json", "read")] } }; },
      async execute(input) {
        state.calls.push("save_report");
        let calculated: string;
        try { calculated = await readFile(join(state.directory, "calculation.json"), "utf8"); } catch { return output("Run calculate_invoice before saving", true); }
        if (input.total !== state.total || input.receipt !== state.receipt || calculated !== JSON.stringify({ total: input.total, receipt: input.receipt })) return output("Use the exact calculator result", true);
        await writeFile(join(state.directory, "report.json"), calculated);
        return output("Report saved; read_report must verify the persisted file");
      },
    })),
    requireValue(createToolPlugin({
      name: "read_report", description: "Read the persisted report. If missing, read_invoice, calculate_invoice, save_report, then read_report again.", inputSchema: empty,
      async prepare() { return { ok: true, value: { actions: { read: "report" }, resources: [resource("report.json", "read")] } }; },
      async execute() {
        state.calls.push("read_report");
        try { return output(await readFile(join(state.directory, "report.json"), "utf8")); }
        catch { return output("Report missing. Read the invoice, calculate it, save the report, then read it again.", true); }
      },
    })),
  ];
}
