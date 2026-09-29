import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fold } from "@x-harness/workflow-core";
import type { RunSnapshot, WorkflowEvent } from "@x-harness/workflow-core";
import { acquireRunLock } from "./lock.ts";

const JOURNAL_NAME = "journal.jsonl";
const HEADER_NAME = "header.json";

export interface RunHeader {
  readonly runId: string;
  readonly parentSession: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly pluginVersion: string;
}

export interface JournalWriter {
  append(events: readonly WorkflowEvent[]): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenResult =
  | { readonly kind: "opened"; readonly writer: JournalWriter; readonly header: RunHeader; readonly snapshot: RunSnapshot | undefined }
  | { readonly kind: "busy" }
  | { readonly kind: "frozen"; readonly reason: string };

export function workflowPluginVersion(): string {
  return "16.0.0";
}

export async function openRunJournal(root: string, header: RunHeader): Promise<OpenResult> {
  const dir = join(root, header.runId);
  await mkdir(dir, { recursive: true });
  const acquired = await acquireRunLock(dir);
  if (acquired.kind !== "acquired") return { kind: "busy" };
  try {
    await writeFile(join(dir, HEADER_NAME), `${JSON.stringify(header, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {
    });
    const readBack = await readHeader(dir);
    if (readBack === undefined || readBack.runId !== header.runId) {
      await acquired.lock.release();
      return { kind: "frozen", reason: `header corrupt or mismatched for run ${header.runId}` };
    }
    const recovered = await recoverJournal(dir, true);
    if (recovered.kind === "frozen") {
      await acquired.lock.release();
      return recovered;
    }
    await chmod(join(dir, JOURNAL_NAME), 0o600).catch(() => {});
    await chmod(join(dir, HEADER_NAME), 0o600).catch(() => {});
    const fh = await open(join(dir, JOURNAL_NAME), "a", 0o600);
    const state: SerialState = { fh, dir, lines: recovered.length };
    const writer = serialWriter(state);
    return { kind: "opened", writer: withLockRelease(writer, acquired.lock), header: readBack, snapshot: recovered.snapshot };
  } catch (error) {
    await acquired.lock.release();
    throw error;
  }
}

export async function readRun(root: string, runId: string): Promise<OpenResult> {
  const dir = join(root, runId);
  const header = await readHeader(dir);
  if (header === undefined) return { kind: "frozen", reason: `header missing for run ${runId}` };
  const recovered = await recoverJournal(dir, false);
  if (recovered.kind === "frozen") return recovered;
  return { kind: "opened", writer: noopWriter, header, snapshot: recovered.snapshot };
}

export async function recoverJournal(dir: string, repair = false): Promise<{ readonly kind: "ok"; readonly snapshot: RunSnapshot | undefined; readonly length: number } | { readonly kind: "frozen"; readonly reason: string }> {
  let raw: string;
  try {
    raw = await readFile(join(dir, JOURNAL_NAME), "utf8");
  } catch {
    return { kind: "ok", snapshot: undefined, length: 0 };
  }
  const lines = raw.split("\n");
  const last = lines.pop() ?? "";
  const events: WorkflowEvent[] = [];
  let index = 0;
  for (const line of lines) {
    if (line === "") continue;
    const parsed = parseLine(line);
    if (parsed === undefined) {
      return index > 0 || lines.length > 1
        ? { kind: "frozen", reason: `journal corrupt at line ${String(index + 1)} (complete line unparseable)` }
        : { kind: "frozen", reason: `journal corrupt at line ${String(index + 1)}` };
    }
    events.push(parsed);
    index += 1;
  }
  if (repair && last !== "") {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await writeFile(join(dir, JOURNAL_NAME), prefix, "utf8");
  }
  let snapshot: RunSnapshot | undefined;
  try {
    snapshot = fold(events);
  } catch (error) {
    return { kind: "frozen", reason: `journal events violate state machine: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { kind: "ok", snapshot, length: lines.filter((line) => line !== "").length };
}

async function readHeader(dir: string): Promise<RunHeader | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, HEADER_NAME), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const h = parsed as Record<string, unknown>;
    if (typeof h["runId"] !== "string" || typeof h["parentSession"] !== "string") return undefined;
    return {
      runId: h["runId"],
      parentSession: h["parentSession"],
      cwd: typeof h["cwd"] === "string" ? h["cwd"] : "",
      createdAt: typeof h["createdAt"] === "number" ? h["createdAt"] : 0,
      pluginVersion: typeof h["pluginVersion"] === "string" ? h["pluginVersion"] : "",
    };
  } catch {
    return undefined;
  }
}

function parseLine(line: string): WorkflowEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as WorkflowEvent;
  } catch {
    return undefined;
  }
}


interface SerialState {
  readonly fh: FileHandle;
  readonly dir: string;
  lines: number;
}

function serialWriter(state: SerialState): JournalWriter {
  const { fh, dir } = state;
  let chain: Promise<void> = Promise.resolve();
  const run = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task, task);
    return chain;
  };
  return {
    append: (events) =>
      run(async () => {
        if (events.length === 0) return;
        const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
        const before = state.lines;
        try {
          await fh.appendFile(lines);
          state.lines = before + events.length;
        } catch (error) {
          const bytes = await byteLengthOf(dir, before).catch(() => 0);
          await fh.truncate(bytes).catch(() => {});
          throw error;
        }
      }),
    sync: () => run(() => fh.sync()),
    close: () => run(async () => {
      await fh.sync().catch(() => {});
      await fh.close();
    }),
  };
}

async function byteLengthOf(dir: string, lineCount: number): Promise<number> {
  if (lineCount === 0) return 0;
  const raw = await readFile(join(dir, JOURNAL_NAME), "utf8").catch(() => "");
  const lines = raw.split("\n");
  const kept = lines.slice(0, lineCount);
  return kept.length === lineCount ? Buffer.byteLength(`${kept.join("\n")}\n`, "utf8") : 0;
}

const noopWriter: JournalWriter = {
  append: () => Promise.reject(new Error("read-only journal")),
  sync: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

function withLockRelease(writer: JournalWriter, lock: { readonly release: () => Promise<void> }): JournalWriter {
  let released = false;
  return {
    append: (events) => writer.append(events),
    sync: () => writer.sync(),
    close: async () => {
      try {
        await writer.close();
      } finally {
        if (!released) {
          released = true;
          await lock.release();
        }
      }
    },
  };
}

export async function rewriteHeaderParent(root: string, runId: string, next: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  const dir = join(root, runId);
  const header = await readHeader(dir);
  if (header === undefined) return;
  const target = join(dir, HEADER_NAME);
  const temp = join(dir, `${HEADER_NAME}.tmp-${String(process.pid)}`);
  await writeFile(temp, `${JSON.stringify({ ...header, parentSession: next }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

async function lockHolderAlive(dir: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(dir, "lock"), "utf8").then((t) => t.trim(), () => "");
  if (raw === "") return false;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function gcRuns(root: string, options: { readonly maxAgeMs: number; readonly now?: () => number }): Promise<readonly string[]> {
  const { readdir, stat, rm } = await import("node:fs/promises");
  const now = options.now?.() ?? Date.now();
  const removed: string[] = [];
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const runId of entries) {
    const read = await readRun(root, runId);
    if (read.kind !== "opened" || read.snapshot === undefined) continue;
    if (read.snapshot.status !== "settled") continue;
    const notifiedAll = Object.values(read.snapshot.tasks).every((task) => task.status !== "settled" || read.snapshot?.notified.has(task.taskId));
    if (!notifiedAll) continue;
    const dir = join(root, runId);
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs < options.maxAgeMs) continue;
    const lockBusy = await lockHolderAlive(dir);
    if (lockBusy) continue;
    const gone = await rm(dir, { recursive: true, force: true }).then(() => true, () => false);
    if (gone) removed.push(runId);
  }
  return removed;
}
