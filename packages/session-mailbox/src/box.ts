// 开箱/认领/manifest/心跳/关箱（docs/AGENT-DELEGATION.md §5.3）。

import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  atomicWrite,
  ensureDir,
  isSafeBoxName,
  manifestClaimable,
  mintBootId,
  readManifest,
  refOf,
  removeDir,
} from "./util.ts";
import type { BoxHandle, MailboxTiming } from "./types.ts";

export interface BoxDeps {
  readonly root: string;
  readonly timing: MailboxTiming;
}

function manifestPath(root: string, name: string): string {
  return join(root, name, "manifest.json");
}

async function writeManifest(deps: BoxDeps, name: string, identity: { readonly pid: number; readonly bootId: string; readonly status: "running" | "idle" }): Promise<void> {
  const manifest = { ...identity, updatedTs: deps.timing.now() };
  await atomicWrite(manifestPath(deps.root, name), `${JSON.stringify(manifest)}\n`);
}

/** 开箱：mkdir 排他；EEXIST → 死箱/超宽限认领（清 inbox/subs 残留并重铸身份）；活箱 throw */
export async function openBox(deps: BoxDeps, name: string): Promise<BoxHandle> {
  if (!isSafeBoxName(name)) throw new Error(`invalid-args:bad box name '${name}'`);
  const dir = join(deps.root, name);
  await ensureDir(deps.root);
  let fresh = false;
  try {
    await mkdir(dir);
    fresh = true;
  } catch {
    // EEXIST：认领裁决
  }
  if (!fresh) {
    const existing = await readManifest(dir);
    if (!manifestClaimable(existing, deps.timing)) {
      throw new Error(`box-name-taken:${name} (pid ${String(existing?.pid ?? "?")} is live)`);
    }
    await clearResidue(dir);
  }
  const bootId = mintBootId();
  let status: "running" | "idle" = "idle";
  const identity = () => ({ pid: process.pid, bootId, status });
  await writeManifest(deps, name, identity());
  await ensureDir(join(dir, "inbox"));
  await ensureDir(join(dir, "subs"));

  return {
    name,
    bootId,
    ref: refOf(bootId),
    setStatus: (next) => {
      status = next;
      return writeManifest(deps, name, identity());
    },
    beat: () => writeManifest(deps, name, identity()),
    startHeartbeat: () => {
      const timer = setInterval(() => {
        void writeManifest(deps, name, identity()).catch(() => {
          /* 心跳失败静默：关箱/认领竞态的自然终态（对端判死接管） */
        });
      }, deps.timing.heartbeatMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    close: () => removeDir(dir),
  };
}

/** 认领清扫：inbox/subs 全清（崩溃残留的 .proc/.msg/.sub 一并） */
async function clearResidue(dir: string): Promise<void> {
  await Promise.all([rm(join(dir, "inbox"), { recursive: true, force: true }), rm(join(dir, "subs"), { recursive: true, force: true })]);
}
