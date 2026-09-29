import { join } from "node:path";
import { readCatalog, buildAssemblySnapshot, resolveDefaultDial } from "../src/shared/catalog.ts";

import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = "/Users/wrr/work/x-harness";
const AGENT_DIR = "/Users/wrr/.pai/agent";
const SESSION_ID = process.env["PROBE_SESSION_ID"] ?? "20260926T191130-5w75d6";
const SESSIONS = join(mkdtempSync(join(tmpdir(), "phase-")), "sessions");
mkdirSync(SESSIONS, { recursive: true });
cpSync(join(AGENT_DIR, "sessions", SESSION_ID), join(SESSIONS, SESSION_ID), { recursive: true });

const catalog = await readCatalog(AGENT_DIR);
const providers = buildAssemblySnapshot(catalog, [], process.env);
const modelMeta: Record<string, unknown> = {};
for (const entry of catalog.entries) {
  modelMeta[entry.model] = {
    reasoning: entry.reasoning,
    ...(entry.input !== undefined ? { input: [...entry.input] } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
  };
}
const defaults = resolveDefaultDial(catalog);
process.env["HUB_WORKER_PROVIDERS"] = JSON.stringify({
  providers,
  ...(defaults !== undefined ? { default: defaults } : {}),
  modelMeta,
});

const t = (label: string, began: number): void => {
  process.stdout.write(`${label.padEnd(44)} ${(performance.now() - began).toFixed(0)}ms\n`);
};

let began = performance.now();
const { resolveWorkerCatalog } = await import("../src/shared/worker-catalog.ts");
const workerCatalog = resolveWorkerCatalog(process.env);
t("resolveWorkerCatalog", began);

began = performance.now();
const { probeBaseFacts } = await import("@x-harness/harness");
const facts = probeBaseFacts({ cwd: REPO, platform: process.platform, env: process.env });
t("probeBaseFacts (git)", began);

began = performance.now();
const { assembleWorkerAgent } = await import("../src/worker/assembly.ts");
process.stdout.write(`catalog.default=${JSON.stringify(workerCatalog.default)} providers=${workerCatalog.providers.length}\n`);
process.stdout.write(`starting assembleWorkerAgent (cwd=${REPO})\n`);
const assembled = await assembleWorkerAgent({
  sessionsRoot: SESSIONS,
  cwd: REPO,
  trusted: true,
  agentDir: AGENT_DIR,
  resumeId: SESSION_ID,
});
t("assembleWorkerAgent (resume, real)", began);

began = performance.now();
await assembled.handle.dispose();
process.stdout.write(`dispose ${(performance.now() - began).toFixed(0)}ms\n`);
process.exit(0);
