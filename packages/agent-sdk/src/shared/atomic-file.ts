import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

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

export function activeAtomicPaths(): number {
  return chains.size;
}
