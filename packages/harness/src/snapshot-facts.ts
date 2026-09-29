import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, createRequestSnapshot, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";
import { permissionMode } from "@x-harness/permission";
import { planControl } from "@x-harness/tool-plan";

export const INSTRUCTIONS_CAP_BYTES = 64 * 1024;

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export function localToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function timeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function renderDateSnapshot(now: Date): string {
  return snapshotEnvelope("date", `Today's date: ${localToday(now)} (${timeZoneLabel()})`);
}

export function renderModelSnapshot(model: string): string {
  return snapshotEnvelope("model", `You are powered by the model ${model}.`);
}

export function renderPermissionModeSnapshot(mode: string): string {
  if (mode === "plan") {
    return snapshotEnvelope("permission-mode", `You are in plan mode: research and read only. Writes, edits, and mutating commands are denied — do not attempt them. When your plan is ready, present it with the plan_submit tool and wait for the user's approval before making any changes.`);
  }
  return snapshotEnvelope("permission-mode", `Permission mode: ${mode}.`);
}

export function renderPermissionModeNonOwnerSnapshot(mode: string): string {
  if (mode === "plan") {
    return snapshotEnvelope("permission-mode", `Permission mode: plan (read-only; only the session that entered plan mode can submit a plan for approval — deliver findings there).`);
  }
  return snapshotEnvelope("permission-mode", `Permission mode: ${mode}.`);
}

export interface InstructionRead {
  readonly body: string;
  readonly warnings: readonly string[];
}

export function readInstructionFiles(cwd: string, capBytes: number = INSTRUCTIONS_CAP_BYTES): InstructionRead {
  const bodies: string[] = [];
  const warnings: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(cwd, name));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") warnings.push(`instructions: ${name} unreadable (${code ?? "io"}), skipped`);
      continue;
    }
    if (buffer.byteLength > capBytes) {
      warnings.push(`instructions: ${name} is ${String(buffer.byteLength)} bytes (> ${String(capBytes)}), skipped`);
      continue;
    }
    const text = buffer.toString("utf8");
    if (bodies.some((existing) => existing === text)) continue;
    bodies.push(text);
  }
  return { body: bodies.join("\n---\n\n"), warnings };
}

function renderInstructionsSnapshot(cwd: string, onWarn?: (message: string) => void): string {
  const read = readInstructionFiles(cwd);
  for (const warning of read.warnings) onWarn?.(warning);
  return read.body === "" ? "" : snapshotEnvelope("project-instructions", read.body);
}

export interface FactsSnapshotOptions {
  readonly cwd: string;
  readonly now?: () => number;
  readonly onWarn?: (message: string) => void;
}

export function createFactsSnapshotPlugin(options: FactsSnapshotOptions): Plugin {
  return {
    name: "facts-snapshot",
    inject: ["agent-loop"],
    softInject: ["permission"],
    apply: (ctx): Disposer => {
      const loop = ctx.use(agentLoopServiceToken);
      const now = options.now ?? (() => Date.now());
      const warn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
      const offs = [
        createTailSnapshot({ ctx, loop, spec: { id: "date", render: () => renderDateSnapshot(new Date(now())), onWarn: warn } }),
        createTailSnapshot({ ctx, loop, spec: { id: "project-instructions", render: () => renderInstructionsSnapshot(options.cwd, warn), onWarn: warn } }),
        createRequestSnapshot({ ctx, loop, spec: { id: "model", render: (dial) => renderModelSnapshot(dial.model), onWarn: warn } }),
        createTailSnapshot({ ctx, loop, spec: { id: "permission-mode", render: (session) => {
          const mode = ctx.tryUse(permissionMode);
          if (mode === undefined) return "";
          if (mode.get() !== "plan") return renderPermissionModeSnapshot(mode.get());
          return ctx.tryUse(planControl)?.owner === session ? renderPermissionModeSnapshot("plan") : renderPermissionModeNonOwnerSnapshot("plan");
        }, onWarn: warn } }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
