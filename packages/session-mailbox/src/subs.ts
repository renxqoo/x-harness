import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { atomicWrite, ensureDir, isSafeBoxName } from "./util.ts";
import type { BoxDeps } from "./box.ts";

interface SubRecord {
  readonly from: string;
  readonly ts: number;
}

function subPath(root: string, box: string, from: string): string {
  return join(root, box, "subs", `${from}.json`);
}

export async function addSub(deps: BoxDeps, targetBox: string, fromBox: string): Promise<void> {
  if (!isSafeBoxName(targetBox) || !isSafeBoxName(fromBox)) {
    throw new Error(`invalid-args:bad box name '${targetBox}'/'${fromBox}'`);
  }
  const record: SubRecord = { from: fromBox, ts: deps.timing.now() };
  await ensureDir(join(deps.root, targetBox, "subs"));
  await atomicWrite(subPath(deps.root, targetBox, fromBox), `${JSON.stringify(record)}\n`);
}

export async function listSubs(deps: BoxDeps, box: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(join(deps.root, box, "subs"));
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

export async function removeSub(deps: BoxDeps, box: string, fromBox: string): Promise<void> {
  await rm(subPath(deps.root, box, fromBox), { force: true });
}
