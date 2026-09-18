// 活箱发现与陈尸回收（docs/AGENT-DELEGATION.md §5.3）：墓碑两步防回收/重开竞态删活箱。

import { join } from "node:path";
import { readdir, rename } from "node:fs/promises";
import { ensureDir, listSubdirs, manifestLive, manifestStale, readManifest, refOf, removeDir } from "./util.ts";
import type { LiveBox } from "./types.ts";
import type { SendDeps } from "./send.ts";
import { sendEnvelope } from "./send.ts";

/** 发现活箱；陈尸（pid 死且超 staleMs）惰性回收后不列 */
export async function discoverBoxes(deps: SendDeps): Promise<readonly LiveBox[]> {
  await ensureDir(deps.root);
  const out: LiveBox[] = [];
  for (const name of await listSubdirs(deps.root)) {
    const manifest = await readManifest(join(deps.root, name));
    if (manifestLive(manifest)) {
      out.push({ name, ref: refOf(manifest?.bootId ?? ""), status: manifest?.status ?? "idle" });
      continue;
    }
    if (manifestStale(manifest, deps.timing)) {
      await reclaimBox(deps, name);
    }
  }
  return out;
}

/** 陈尸回收：墓碑 rename → 复验（活则还原跳过）→ 墓碑内 subs 直读结算 idle-expired → 删墓碑。
 *  复验捕获的竞态：判尸后、rename 前 box 被新进程认领重写——rename 搬走的是新 manifest，复验即见活。 */
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
    return; // 目录已不在（他者先回收/关箱）
  }
  await hooks?.afterTombstone?.(tomb);
  const recheck = await readManifest(tomb);
  if (manifestLive(recheck)) {
    await rename(tomb, dir).catch(() => {
      /* 还原失败：原位被新箱占用——旧内容留墓碑，随陈尸阈值自然清扫 */
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
      /* 订阅方也死：订阅随目标终结（规格「订阅存活期=目标会话存活期」） */
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
