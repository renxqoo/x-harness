import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubLog } from "./hub-log.ts";
import type { PluginProposalRecord } from "../worker/plugin-propose.ts";

export type { PluginProposalRecord };

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const confirmedIds = new Set<string>();

export function proposalsPath(agentDir: string): string {
  return join(agentDir, "plugins", "proposals.json");
}

function entryValid(value: unknown): value is PluginProposalRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["proposalId"] === "string" &&
    r["proposalId"] !== "" &&
    typeof r["sourcePath"] === "string" &&
    typeof r["name"] === "string" &&
    typeof r["description"] === "string" &&
    Array.isArray(r["requestedCapabilities"]) &&
    typeof r["sha256"] === "string" &&
    r["sha256"] !== "" &&
    typeof r["createdAt"] === "number" &&
    typeof r["confirmed"] === "boolean" &&
    typeof r["consumed"] === "boolean"
  );
}

async function readProposals(agentDir: string): Promise<PluginProposalRecord[]> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(proposalsPath(agentDir)).text();
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    hubLog(`plugin proposals unreadable; degraded to empty (${proposalsPath(agentDir)})`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PluginProposalRecord[] = [];
  for (const item of parsed) {
    if (entryValid(item)) out.push(item);
  }
  const now = Date.now();
  return out.filter((record) => now - record.createdAt <= PROPOSAL_TTL_MS);
}

async function writeProposals(agentDir: string, next: PluginProposalRecord[]): Promise<void> {
  await updateJson(proposalsPath(agentDir), {
    read: () => readProposals(agentDir),
    write: async (rows) => {
      await mkdir(join(agentDir, "plugins"), { recursive: true });
      await atomicWriteJson(proposalsPath(agentDir), rows);
    },
    mutate: () => next,
  });
}

export interface PluginProposalStore {
  record(proposal: PluginProposalRecord): Promise<void>;
  list(): Promise<readonly PluginProposalRecord[]>;
  setConfirmed(proposalId: string, confirmed: boolean): Promise<boolean>;
  consumeConfirmed(proposalId: string): Promise<PluginProposalRecord | undefined>;
}

export function createPluginProposalStore(agentDir: string): PluginProposalStore {
  return {
    async record(proposal) {
      const current = await readProposals(agentDir);
      await writeProposals(agentDir, [...current.filter((r) => r.proposalId !== proposal.proposalId), { ...proposal }]);
    },
    async list() {
      return readProposals(agentDir);
    },
    async setConfirmed(proposalId, confirmed) {
      const current = await readProposals(agentDir);
      const found = current.find((r) => r.proposalId === proposalId);
      if (found === undefined) return false;
      if (confirmed) confirmedIds.add(proposalId);
      else confirmedIds.delete(proposalId);
      found.confirmed = confirmed;
      await writeProposals(agentDir, current);
      return true;
    },
    async consumeConfirmed(proposalId) {
      const current = await readProposals(agentDir);
      const found = current.find((r) => r.proposalId === proposalId);
      if (found === undefined || !confirmedIds.has(proposalId)) return undefined;
      confirmedIds.delete(proposalId);
      await writeProposals(agentDir, current.filter((r) => r.proposalId !== proposalId));
      return { ...found };
    },
  };
}

export function resetProposalConfirms(): void {
  confirmedIds.clear();
}
