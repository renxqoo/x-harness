import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deepFreeze } from "@x-harness/core";
import { isSafeSessionId, validateSessionEvents } from "@x-harness/session";
import type { SessionArchive, SessionEvent, SessionHeader, SessionId } from "@x-harness/session";

function listIds(root: string): readonly SessionId[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return Object.freeze([] as SessionId[]);
    throw error;
  }
  return Object.freeze(
    entries
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "header.json")))
      .map((entry) => entry.name as SessionId),
  );
}

export function createArchiveReader(root: string): SessionArchive {
  return {
    list: () => listIds(root),

    listHeaders: async () => {
      const out: SessionHeader[] = [];
      for (const id of listIds(root)) {
        let text: string;
        try {
          text = await readFile(join(root, id, "header.json"), "utf8");
        } catch {
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          continue;
        }
        if (gateHeader(json, id) !== undefined) continue;
        out.push(json as SessionHeader);
      }
      return Object.freeze(out);
    },

    read: async (id) => {
      if (!isSafeSessionId(id)) return { ok: false, reason: `invalid-id:${id}` };
      const dir = join(root, id);

      let headerText: string;
      try {
        headerText = await readFile(join(dir, "header.json"), "utf8");
      } catch {
        return { ok: false, reason: `no-header:${id}` };
      }
      let headerJson: unknown;
      try {
        headerJson = JSON.parse(headerText);
      } catch {
        return { ok: false, reason: `corrupt-header:${id}` };
      }
      const headerErr = gateHeader(headerJson, id);
      if (headerErr !== undefined) return { ok: false, reason: headerErr };
      const header = headerJson as SessionHeader;

      let text: string;
      try {
        text = await readFile(join(dir, "events.jsonl"), "utf8");
      } catch {
        return { ok: false, reason: `no-events:${id}` };
      }
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const events: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line === "") return { ok: false, reason: `corrupt:${id}:line${i}` };
        try {
          events.push(JSON.parse(line));
        } catch {
          if (i === lines.length - 1) break;
          return { ok: false, reason: `corrupt:${id}:line${i}` };
        }
      }
      const validateErr = validateSessionEvents(events);
      if (validateErr !== undefined) return { ok: false, reason: `${validateErr}:${id}` };
      return { ok: true, value: deepFreeze({ header, events: events as SessionEvent[] }) };
    },
  };
}

const STRING_FIELDS = ["cwd", "parentSession", "agentId", "agentType", "agentWork", "agentWorktree"] as const;

function gateHeader(value: unknown, id: string): string | undefined {
  if (typeof value !== "object" || value === null) return `corrupt-header:${id}`;
  const record = value as Record<string, unknown>;
  if (record["id"] !== id) return `corrupt-header:${id}:id-mismatch`;
  if (typeof record["createdAt"] !== "number" || !Number.isFinite(record["createdAt"])) return `corrupt-header:${id}`;
  for (const field of STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== "string") return `corrupt-header:${id}:${field}`;
  }
  const depth = record["agentDepth"];
  if (depth !== undefined && (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0)) {
    return `corrupt-header:${id}:agentDepth`;
  }
  return undefined;
}
