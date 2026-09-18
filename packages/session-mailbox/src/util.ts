// 邮箱文件协议共用件：box 名安全门、原子写、manifest 读写、判活。

import { kill } from "node:process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { BoxManifest, MailboxTiming } from "./types.ts";

const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeBoxName(name: string): boolean {
  return BOX_NAME.test(name);
}

let tmpCounter = 0;

/** tmp→rename 原子替换：读方永不见半写文件；tmp 名带唯一后缀——并发写者不共用同一
 *  tmp（交错损坏会被 rename 发布成坏文件——审查 B-P1-3） */
export async function atomicWrite(path: string, text: string): Promise<void> {
  tmpCounter += 1;
  const tmp = `${path}.${process.pid}-${String(tmpCounter)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
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

/** 陈尸 = pid 死且超 staleMs。manifest 坏/缺（undefined）不无条件判死——读方应配
 *  statStale（目录 mtime 超龄）再判，防坏 manifest 触发活箱回收（审查 B-P1-3 放大链） */
export function manifestStale(manifest: BoxManifest | undefined, timing: MailboxTiming): boolean {
  if (manifest === undefined) return false;
  return !pidAlive(manifest.pid) && timing.now() - manifest.updatedTs > timing.staleMs;
}

/** manifest 缺席时的保守陈尸判据：目录 mtime 超龄（内容增删才刷新；rename 覆盖不刷新——
 *  活箱因 inbox/subs 活动而 mtime 新鲜） */
export async function statStale(dir: string, timing: MailboxTiming): Promise<boolean> {
  try {
    const info = await (await import("node:fs/promises")).stat(dir);
    return timing.now() - info.mtimeMs > timing.staleMs;
  } catch {
    return false;
  }
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
