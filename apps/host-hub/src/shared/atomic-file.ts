// 原子 JSON 文件三件套（settings/trust/catalog 三处同机制单点）：
// tmp+rename 原子写、按路径分链串行（read-modify-write 排队不丢更新）、链空闲回收
// （身份比对——并发同路径永不失串行，distinct 路径无界增长由回收兜底）。
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

/** 原子写（tmp 命名带 pid+uuid——无碰撞；目录须已存在） */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/** 读 JSON（坏文件/缺席返回 fallback——调用方定降级方向） */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const chains = new Map<string, Promise<unknown>>();

function reclaim(path: string, chain: Promise<unknown>): void {
  void chain.then(
    () => {
      if (chains.get(path) === chain) chains.delete(path);
    },
    () => {
      if (chains.get(path) === chain) chains.delete(path);
    },
  );
}

/** 路径级串行读改写（失败不毒化链；回收有界） */
export function updateJson<T>(path: string, ops: { read: () => Promise<T>; write: (next: T) => Promise<void>; mutate: (current: T) => T | Promise<T> }): Promise<T> {
  const run = async (): Promise<T> => {
    const current = await ops.read();
    const next = await ops.mutate(current);
    await ops.write(next);
    return next;
  };
  const prev = chains.get(path) ?? Promise.resolve();
  const chain = prev.then(run, run);
  chains.set(path, chain);
  reclaim(path, chain);
  return chain as Promise<T>;
}

/** 写链活跃路径数（测试口径：回收有界性断言） */
export function activeAtomicPaths(): number {
  return chains.size;
}
