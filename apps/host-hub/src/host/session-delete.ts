import { mkdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import type { ThreadTable } from "./thread-table.ts";
import { fenceSessionPath } from "./read-history.ts";

export interface DeleteDeps {
  readonly table: ThreadTable;
  readonly sessionsRoot: string;
  readonly taskLogsRoot: string;
  readonly agentDir: string;
}

export type DeleteResult = { ok: true; removed: string[] } | { ok: false; reason: HubErrorShape };

function isLiveFamily(state: string | undefined): boolean {
  return state === undefined || state === "live" || state === "spawning" || state === "retiring";
}

async function lockHeldByLiveProcess(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, "lock"), "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isSubagentSession(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, "header.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  try {
    const header = JSON.parse(raw) as { agentId?: unknown };
    return typeof header.agentId === "string" && header.agentId !== "";
  } catch {
    return false;
  }
}

async function descendantIds(sessionsRoot: string, rootId: string): Promise<string[]> {
  const headers = await createArchiveReader(sessionsRoot).listHeaders().catch(() => undefined);
  if (headers === undefined) return [];
  const byParent = new Map<string, string[]>();
  for (const header of headers) {
    if (header.parentSession === undefined) continue;
    const siblings = byParent.get(String(header.parentSession)) ?? [];
    siblings.push(String(header.id));
    byParent.set(String(header.parentSession), siblings);
  }
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier = byParent.get(rootId) ?? [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      next.push(...(byParent.get(id) ?? []));
    }
    frontier = next;
  }
  return out;
}

type VanishOutcome = "renamed" | "absent" | "failed";

async function vanishTaskLogs(deps: DeleteDeps, id: string): Promise<boolean> {
  const outcome = await vanishToTrash(join(deps.taskLogsRoot, id), deps.agentDir, `${id}.logs`);
  return outcome !== "failed";
}

async function cascadeChildren(deps: DeleteDeps, children: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const child of children) {
    if (!(await vanishTaskLogs(deps, child))) {
      process.stderr.write(`hub: session-delete task-logs cascade skipped ${child}\n`);
    }
    const outcome = await vanishToTrash(join(deps.sessionsRoot, child), deps.agentDir, child);
    if (outcome === "renamed") {
      removed.push(child);
      withdrawTableEntry(deps.table, join(deps.sessionsRoot, child, "events.jsonl"));
    } else if (outcome === "failed") {
      process.stderr.write(`hub: session-delete cascade skipped ${child}\n`);
    }
  }
  return removed;
}

async function vanishToTrash(dir: string, agentDir: string, id: string): Promise<VanishOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const trash = join(agentDir, "trash", `${id}.${process.pid}.${randomBytes(6).toString("hex")}`);
    try {
      await rename(dir, trash);
      const now = new Date();
      await utimes(trash, now, now).catch(() => {});
      void rm(trash, { recursive: true, force: true }).catch(() => {});
      return "renamed";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "absent";
      if (code !== "EEXIST" && code !== "ENOTEMPTY") return "failed";
    }
  }
  return "failed";
}

function withdrawTableEntry(table: ThreadTable, sessionPath: string): void {
  const holder = table.holderOf(sessionPath);
  if (holder !== undefined) table.remove(holder);
}

export async function deleteSession(deps: DeleteDeps, sessionPath: string): Promise<DeleteResult> {
  const fence = await fenceSessionPath(sessionPath, deps.sessionsRoot);
  if (!fence.ok) return { ok: false, reason: fence.reason };
  const dir = join(deps.sessionsRoot, fence.threadId);
  const canonicalPath = join(deps.sessionsRoot, fence.threadId, "events.jsonl");
  const holderState = (): "none" | string | undefined => {
    const holder = deps.table.holderOf(canonicalPath);
    if (holder === undefined) return "none";
    return deps.table.get(holder)?.state;
  };

  const dirStat = await stat(dir).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (dirStat instanceof Error && dirStat.code !== "ENOENT") {
    return { ok: false, reason: hubError("io_failed", `delete failed: ${dirStat.code ?? "stat"}`) };
  }
  if (dirStat instanceof Error) {
    if (isLiveFamily(holderState())) return { ok: false, reason: hubError("already_open", "already open") };
    withdrawTableEntry(deps.table, canonicalPath);
    if (!(await vanishTaskLogs(deps, fence.threadId))) {
      return { ok: false, reason: hubError("io_failed", "delete failed: task-logs rename") };
    }
    return { ok: true, removed: [] };
  }
  if (isLiveFamily(holderState())) return { ok: false, reason: hubError("already_open", "already open") };
  if (await lockHeldByLiveProcess(dir)) {
    return { ok: false, reason: hubError("already_open", "session is locked by another process") };
  }
  if (await isSubagentSession(dir)) {
    return { ok: false, reason: hubError("state_conflict", "cannot delete subagent session") };
  }
  const children = await descendantIds(deps.sessionsRoot, fence.threadId);
  await mkdir(join(deps.agentDir, "trash"), { recursive: true }).catch(() => {});

  if (!(await vanishTaskLogs(deps, fence.threadId))) {
    return { ok: false, reason: hubError("io_failed", "delete failed: task-logs rename") };
  }

  withdrawTableEntry(deps.table, canonicalPath);

  const vanished = await vanishToTrash(dir, deps.agentDir, fence.threadId);
  if (vanished === "failed") return { ok: false, reason: hubError("io_failed", "delete failed: rename") };
  const removed = vanished === "renamed" ? [fence.threadId] : [];
  removed.push(...(await cascadeChildren(deps, children)));
  return { ok: true, removed };
}
