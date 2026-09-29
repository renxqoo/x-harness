import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AuditEvent =
  | "gateway-started"
  | "gateway-stopped"
  | "host-restarted"
  | "pairing-created"
  | "pairing-confirmed"
  | "pairing-failed"
  | "device-revoked"
  | "device-scope-changed"
  | "command-issued"
  | "ui_request-settled"
  | "owner-only-denied"
  | "scope-denied"
  | "config-changed"
  | "rekey-performed"
  | "ratchet-regression"
  | "replay-rejected"
  | "enroll-conflict";

export interface AuditLog {
  record(event: AuditEvent, detail: Record<string, unknown>): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_BYTES_CAP = 64 * 1024 * 1024;
const RETENTION_DAYS = 30;

export async function openAuditLog(dir: string, now: () => number): Promise<AuditLog> {
  await mkdir(dir, { recursive: true });
  await sweepOldDays(dir, now);
  let currentDate = dayKey(now());
  let bytes = await fileBytesOf(join(dir, `${currentDate}.jsonl`));
  const write = async (line: string): Promise<void> => {
    const today = dayKey(now());
    if (today !== currentDate) {
      currentDate = today;
      bytes = 0;
      await sweepOldDays(dir, now);
    }
    if (bytes >= DAY_BYTES_CAP) return;
    await appendFile(join(dir, `${currentDate}.jsonl`), `${line}\n`, "utf8");
    bytes += Buffer.byteLength(line) + 1;
  };
  return {
    async record(event, detail) {
      await write(JSON.stringify({ ts: new Date(now()).toISOString(), event, ...detail }));
    },
  };
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

async function fileBytesOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return 0;
  }
}

async function sweepOldDays(dir: string, now: () => number): Promise<void> {
  const cutoff = now() - RETENTION_DAYS * DAY_MS;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const ts = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(ts)) continue;
    if (ts < cutoff) await unlink(join(dir, name)).catch(() => {});
  }
}
