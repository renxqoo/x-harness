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

export async function openBox(deps: BoxDeps, name: string): Promise<BoxHandle> {
  if (!isSafeBoxName(name)) throw new Error(`invalid-args:bad box name '${name}'`);
  const dir = join(deps.root, name);
  await ensureDir(deps.root);
  let fresh = false;
  try {
    await mkdir(dir);
    fresh = true;
  } catch {
  }
  if (!fresh) {
    const existing = await readManifest(dir);
    if (!manifestClaimable(existing, deps.timing)) {
      throw new Error(`box-name-taken:${name} (pid ${String(existing?.pid ?? "?")} is live)`);
    }
    await claimAtomically(dir, name);
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
        });
      }, deps.timing.heartbeatMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    close: async () => {
      const current = await readManifest(dir);
      if (current?.bootId !== bootId) return;
      await removeDir(dir);
    },
  };
}

async function claimAtomically(dir: string, name: string): Promise<void> {
  const claimPath = join(dir, `claim-${String(process.pid)}-${String(Date.now())}`);
  try {
    const handle = await (await import("node:fs/promises")).open(claimPath, "wx");
    await handle.close();
  } catch {
    throw new Error(`box-name-taken:${name} (concurrent claim won)`);
  }
  await (await import("node:fs/promises")).rm(claimPath, { force: true });
}

async function clearResidue(dir: string): Promise<void> {
  await Promise.all([rm(join(dir, "inbox"), { recursive: true, force: true }), rm(join(dir, "subs"), { recursive: true, force: true })]);
}
