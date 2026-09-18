// 原子投递与抢占排空（docs/AGENT-DELEGATION.md §5.3）。

import { join } from "node:path";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ensureDir, isSafeBoxName, manifestLive, readManifest } from "./util.ts";
import type { BoxDeps } from "./box.ts";
import type { Envelope, EnvelopeKind, SendResult } from "./types.ts";

export interface SendDeps extends BoxDeps {
  readonly onWarn?: (message: string) => void;
}

function inboxDir(root: string, box: string): string {
  return join(root, box, "inbox");
}

function parseEnvelope(text: string): Envelope | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const raw = json as Partial<Envelope>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.from !== "string" ||
    typeof raw.to !== "string" ||
    typeof raw.message !== "string" ||
    typeof raw.ts !== "number" ||
    (raw.kind !== "message" && raw.kind !== "idle-notice" && raw.kind !== "idle-expired")
  ) {
    return undefined;
  }
  return { id: raw.id, from: raw.from, to: raw.to, message: raw.message, ts: raw.ts, kind: raw.kind };
}

/** 投递：判活 → tmp 写入 → rename 发布（读方永不见半写文件） */
export async function sendEnvelope(deps: SendDeps, to: string, body: { readonly from: string; readonly message: string; readonly kind: EnvelopeKind }): Promise<SendResult> {
  if (!isSafeBoxName(to) || !isSafeBoxName(body.from)) {
    return { ok: false, reason: `invalid-args:bad box name '${to}'/'${body.from}'` };
  }
  const dir = join(deps.root, to);
  if (!manifestLive(await readManifest(dir))) {
    return { ok: false, reason: `not-live:${to}` };
  }
  const envelope: Envelope = { id: randomUUID(), from: body.from, to, message: body.message, ts: deps.timing.now(), kind: body.kind };
  const inbox = inboxDir(deps.root, to);
  await ensureDir(inbox);
  const base = join(inbox, envelope.id);
  await writeFile(`${base}.tmp`, `${JSON.stringify(envelope)}\n`);
  await rename(`${base}.tmp`, `${base}.msg`);
  return { ok: true, id: envelope.id };
}

/** 抢占排空：rename .proc 单读者保证；坏信封丢弃（onWarn）；at-most-once（crash 窗口 .proc 残留=接受丢失） */
export async function drainInbox(deps: SendDeps, box: string): Promise<readonly Envelope[]> {
  const inbox = inboxDir(deps.root, box);
  let names: readonly string[];
  try {
    names = await readdir(inbox);
  } catch {
    return [];
  }
  const out: Envelope[] = [];
  for (const name of names) {
    if (!name.endsWith(".msg")) continue;
    const base = join(inbox, name);
    const proc = `${base.slice(0, -".msg".length)}.proc`;
    try {
      await rename(base, proc);
    } catch {
      continue; // 他 drain 先抢：单读者语义
    }
    const text = await readFile(proc, "utf8").catch(() => undefined);
    await rm(proc, { force: true });
    if (text === undefined) {
      deps.onWarn?.(`mailbox: unreadable envelope ${name} dropped`);
      continue;
    }
    const envelope = parseEnvelope(text);
    if (envelope === undefined) {
      deps.onWarn?.(`mailbox: malformed envelope ${name} dropped`);
      continue;
    }
    out.push(envelope);
  }
  out.sort(byTsThenId);
  return out;
}

function byTsThenId(a: Envelope, b: Envelope): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : 1;
}
