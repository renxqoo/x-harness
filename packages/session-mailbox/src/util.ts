// 邮箱文件协议共用件：box 名安全门、原子写、manifest 读写、判活。

import { kill } from "node:process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { BoxManifest, MailboxTiming } from "./types.ts";

const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeBoxName(name: string): boolean {
  return BOX_NAME.test(name);
}

/** tmp→rename 原子替换：读方永不见半写文件（方案 §5.3 原子性三则之二） */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

/** manifest 坏/缺 → undefined（判活退回 pid 面由调用方定夺） */
export async function readManifest(dir: string): Promise<BoxManifest | undefined> {
  try {
    return parseManifest(await readFile(`${dir}/manifest.json`, "utf8"));
  } catch {
    return undefined;
  }
}

export function parseManifest(text: string): BoxManifest | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const raw = json as Partial<BoxManifest>;
  if (
    typeof raw.pid !== "number" ||
    !Number.isSafeInteger(raw.pid) ||
    typeof raw.bootId !== "string" ||
    (raw.status !== "running" && raw.status !== "idle") ||
    typeof raw.updatedTs !== "number" ||
    !Number.isSafeInteger(raw.updatedTs)
  ) {
    return undefined;
  }
  return { pid: raw.pid, bootId: raw.bootId, status: raw.status, updatedTs: raw.updatedTs };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 判活 = pid 活（宽限不参与——死即死，防与认领条件矛盾） */
export function manifestLive(manifest: BoxManifest | undefined): boolean {
  if (manifest === undefined) return false;
  return pidAlive(manifest.pid);
}

/** 认领条件 = pid 死或超宽限（心跳断流的活进程容忍三拍丢失后让位——方案 §5.3 开箱） */
export function manifestClaimable(manifest: BoxManifest | undefined, timing: MailboxTiming): boolean {
  if (manifest === undefined) return true;
  if (!pidAlive(manifest.pid)) return true;
  return timing.now() - manifest.updatedTs > timing.graceMs;
}

/** 陈尸 = pid 死且超 staleMs */
export function manifestStale(manifest: BoxManifest | undefined, timing: MailboxTiming): boolean {
  if (manifest === undefined) return true;
  return !pidAlive(manifest.pid) && timing.now() - manifest.updatedTs > timing.staleMs;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function listSubdirs(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name !== ".tomb").map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function mintBootId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function refOf(bootId: string): string {
  return bootId.slice(-6);
}
