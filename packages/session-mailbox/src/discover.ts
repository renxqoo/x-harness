import { join } from "node:path";
import { readdir, rename } from "node:fs/promises";
import { ensureDir, listSubdirs, manifestLive, manifestStale, readManifest, refOf, removeDir, statStale } from "./util.ts";
import type { LiveBox } from "./types.ts";
import type { SendDeps } from "./send.ts";
import { sendEnvelope } from "./send.ts";

export async function discoverBoxes(deps: SendDeps): Promise<readonly LiveBox[]> {
  await ensureDir(deps.root);
  const out: LiveBox[] = [];
  for (const name of await listSubdirs(deps.root)) {
    const manifest = await readManifest(join(deps.root, name));
    if (manifestLive(manifest)) {
      out.push({ name, ref: refOf(manifest?.bootId ?? ""), status: manifest?.status ?? "idle" });
      continue;
    }
    if (manifestStale(manifest, deps.timing) || (manifest === undefined && (await statStale(join(deps.root, name), deps.timing)))) {
      await reclaimBox(deps, name);
    }
  }
  return out;
}

export async function reclaimBox(
  deps: SendDeps,
  name: string,
  hooks?: { readonly afterTombstone?: (tombPath: string) => Promise<void> },
): Promise<void> {
  const dir = join(deps.root, name);
  const tomb = join(deps.root, ".tomb", `${name}-${String(deps.timing.now())}`);
  await ensureDir(join(deps.root, ".tomb"));
  try {
    await rename(dir, tomb);
  } catch {
    return;
  }
  await hooks?.afterTombstone?.(tomb);
  const recheck = await readManifest(tomb);
  if (manifestLive(recheck)) {
    await rename(tomb, dir).catch(() => {
    });
    return;
  }
  for (const file of await subsFiles(tomb)) {
    const from = file.slice(0, -".json".length);
    await sendEnvelope(deps, from, {
      from: name,
      message: `[Cross-session idle notice] subscription expired: ${name} gone`,
      kind: "idle-expired",
    }).catch(() => {
    });
  }
  await removeDir(tomb);
}

async function subsFiles(tomb: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(tomb, "subs"))).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}
