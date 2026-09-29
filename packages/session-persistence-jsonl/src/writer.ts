import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent, SessionHeader } from "@x-harness/session";
import { canonicallyEqual } from "./equal.ts";
import { acquireSessionLock } from "./lock.ts";
import type { SessionLock } from "./lock.ts";

export interface SessionWriter {
  append(lines: readonly string[]): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenedWriter {
  readonly writer: SessionWriter;
  readonly prefixLength: number;
}

export function isPermanentRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { permanent?: unknown }).permanent === true;
}

function permanentRejection(reason: string): Error {
  return Object.assign(new Error(reason), { permanent: true });
}

export function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

export async function openSessionWriter(
  dir: string,
  header: SessionHeader,
  currentEvents: readonly SessionEvent[],
): Promise<OpenedWriter> {
  await mkdir(dir, { recursive: true });
  const lock = await acquireSessionLock(dir, dirName(dir));
  let opened: OpenedWriter;
  try {
    opened = await openUnlocked(dir, header, currentEvents);
  } catch (error) {
    await lock.release();
    throw error;
  }
  return { writer: withLockRelease(opened.writer, lock), prefixLength: opened.prefixLength };
}

function withLockRelease(writer: SessionWriter, lock: SessionLock): SessionWriter {
  return {
    append: (lines) => writer.append(lines),
    sync: () => writer.sync(),
    close: async () => {
      try {
        await writer.close();
      } finally {
        await lock.release();
      }
    },
  };
}

async function openUnlocked(dir: string, header: SessionHeader, currentEvents: readonly SessionEvent[]): Promise<OpenedWriter> {
  const eventsPath = join(dir, "events.jsonl");
  const headerPath = join(dir, "header.json");

  let fh: FileHandle;
  try {
    fh = await open(eventsPath, "ax");
  } catch (axError) {
    if (!isEexistError(axError)) throw axError;
    return resumeSessionWriter({ dir, header, currentEvents });
  }

  try {
    await writeFile(headerPath, `${JSON.stringify(header)}\n`, { flag: "wx" });
  } catch (wxError) {
    await fh.close().then(
      () => {},
      () => {},
    );
    await unlink(eventsPath).then(
      () => {},
      () => {},
    );
    throw wxError;
  }
  return { writer: makeWriter(fh), prefixLength: 0 };
}

async function resumeSessionWriter(input: {
  readonly dir: string;
  readonly header: SessionHeader;
  readonly currentEvents: readonly SessionEvent[];
}): Promise<OpenedWriter> {
  const { dir, header, currentEvents } = input;
  const eventsPath = join(dir, "events.jsonl");
  const text = await readFile(eventsPath, "utf8");
  const { kept, events: diskEvents } = parseDiskVolume(text, dir);

  const diskHeader = await readHeaderFile(dir);
  if (diskHeader === undefined) throw permanentRejection(`archive-orphan-events:${dirName(dir)}`);
  if (!canonicallyEqual(diskHeader, header)) throw permanentRejection(`session-id-reused:${dirName(dir)}`);

  if (diskEvents.length > currentEvents.length) throw permanentRejection(`archive-prefix-mismatch:${dirName(dir)}`);
  for (let i = 0; i < diskEvents.length; i++) {
    if (!canonicallyEqual(diskEvents[i], currentEvents[i])) {
      throw permanentRejection(`archive-prefix-mismatch:${dirName(dir)}`);
    }
  }

  const fh = await open(eventsPath, "a");
  if (kept.length < text.length) await fh.truncate(kept.length);
  return { writer: makeWriter(fh), prefixLength: diskEvents.length };
}

function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

function parseDiskVolume(text: string, dir: string): { readonly kept: string; readonly events: unknown[] } {
  let kept = text;
  if (text !== "" && !text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    kept = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  }
  const lines = kept.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const events: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") throw permanentRejection(`archive-corrupt:${dirName(dir)}:blank-line`);
    try {
      events.push(JSON.parse(line));
    } catch {
      throw permanentRejection(`archive-corrupt:${dirName(dir)}:line${String(i)}`);
    }
  }
  return { kept, events };
}

async function readHeaderFile(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, "header.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function makeWriter(fh: FileHandle): SessionWriter {
  return {
    append: async (lines) => {
      if (lines.length === 0) return;
      const before = await fh.stat().then((stat) => stat.size);
      try {
        await fh.appendFile(lines.join(""));
      } catch (error) {
        await fh.truncate(before).then(
          () => {},
          () => {},
        );
        throw error;
      }
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  };
}
