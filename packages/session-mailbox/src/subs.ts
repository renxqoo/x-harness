// 一次性 idle 订阅（docs/AGENT-DELEGATION.md §5.4）：订阅者写目标、目标自查自结算。

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

/** 订阅：向目标 box 写 {from, ts}（原子重写，同 from 覆盖=刷新） */
export async function addSub(deps: BoxDeps, targetBox: string, fromBox: string): Promise<void> {
  if (!isSafeBoxName(targetBox) || !isSafeBoxName(fromBox)) {
    throw new Error(`invalid-args:bad box name '${targetBox}'/'${fromBox}'`);
  }
  const record: SubRecord = { from: fromBox, ts: deps.timing.now() };
  await ensureDir(join(deps.root, targetBox, "subs"));
  await atomicWrite(subPath(deps.root, targetBox, fromBox), `${JSON.stringify(record)}\n`);
}

/** 目标自查订阅方清单（结算输入） */
export async function listSubs(deps: BoxDeps, box: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(join(deps.root, box, "subs"));
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

/** 结算摘除（一次性语义的执法点） */
export async function removeSub(deps: BoxDeps, box: string, fromBox: string): Promise<void> {
  await rm(subPath(deps.root, box, fromBox), { force: true });
}
