import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "../index.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-obs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProbeInput {
  readonly registry: ObservedRegistry;
  readonly key: string;
  readonly log: string[];
  readonly tag: string;
}

async function probe(input: ProbeInput): Promise<string> {
  const { registry, key, log, tag } = input;
  return registry.locked(key, async () => {
    log.push(`enter:${tag}`);
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
    log.push(`exit:${tag}`);
    return tag;
  });
}

function maxConcurrent(log: readonly string[]): number {
  let open = 0;
  let maxOpen = 0;
  for (const entry of log) {
    if (entry.startsWith("enter:")) open += 1;
    else open -= 1;
    maxOpen = Math.max(maxOpen, open);
  }
  return maxOpen;
}

describe("ObservedRegistry.locked 锁键互斥", () => {
  it("同锁键串行：临界区不交叉（enter→exit→enter→exit）", async () => {
    const registry = new ObservedRegistry();
    const log: string[] = [];
    await Promise.all([probe({ registry, key: "/f.ts", log, tag: "a" }), probe({ registry, key: "/f.ts", log, tag: "b" })]);
    const enters = log.filter((entry) => entry.startsWith("enter:"));
    const exits = log.filter((entry) => entry.startsWith("exit:"));
    const maxOpen = maxConcurrent(log);
    expect(enters).toHaveLength(2);
    expect(exits).toHaveLength(2);
    expect(maxOpen).toBe(1);
  });

  it("不同锁键并行：两临界区交叉（maxOpen = 2）", async () => {
    const registry = new ObservedRegistry();
    const log: string[] = [];
    await Promise.all([probe({ registry, key: "/a.ts", log, tag: "a" }), probe({ registry, key: "/b.ts", log, tag: "b" })]);
    const maxOpen = maxConcurrent(log);
    expect(maxOpen).toBe(2);
  });

  it("词法别名同锁（B1 修复面）：两别名经 env.realpath 归一到同键 → 互斥", async () => {
    const env = createLocalEnv(root);
    writeFileSync(join(root, "f.txt"), "x");
    const aliasA = join(root, "f.txt");
    const aliasB = join(await env.realpath(root), "f.txt");
    const keyA = await env.realpath(aliasA);
    const keyB = await env.realpath(aliasB);
    expect(keyA).toBe(keyB);
    const registry = new ObservedRegistry();
    const log: string[] = [];
    await Promise.all([probe({ registry, key: keyA, log, tag: "a" }), probe({ registry, key: keyB, log, tag: "b" })]);
    const maxOpen = maxConcurrent(log);
    expect(maxOpen).toBe(1);
  });

  it("锁键与 I/O 键解耦（回归）：write 以 realpath 为锁键、词法路径为 I/O——symlink 场景写仍落词法位置", async () => {
    const env = createLocalEnv(root);
    writeFileSync(join(root, "real-target.txt"), "body\n");
    symlinkSync(join(root, "real-target.txt"), join(root, "alias.txt"));
    const lexical = join(root, "alias.txt");
    const lockKey = await env.realpath(lexical);
    expect(lockKey).toBe(join(await env.realpath(root), "real-target.txt"));
    const registry = new ObservedRegistry();
    const wrote = await registry.locked(lockKey, async () => {
      const result = await env.writeFileAtomic(lexical, Buffer.from("via-alias\n", "utf8"), { makeParents: false });
      return result.ok;
    });
    expect(wrote).toBe(true);
    expect(readFileSync(join(root, "real-target.txt"), "utf8")).toBe("body\n");
    expect(readFileSync(join(root, "alias.txt"), "utf8")).toBe("via-alias\n");
  });

  it("realpath 键回归（B1）：锁键面与 ObservedRegistry 其余面无耦合——record/lookup/stale/evict 不受影响", () => {
    const registry = new ObservedRegistry();
    const version = { ino: "1", size: "2", mtimeNs: "3", hadBom: false };
    registry.record("s" as never, "/f.txt", version);
    expect(registry.lookup("s" as never, "/f.txt")).toEqual(version);
    expect(ObservedRegistry.stale(version, { ...version, mtimeNs: "4" })).toBe(true);
    expect(ObservedRegistry.stale(version, version)).toBe(false);
    registry.evict("s" as never);
    expect(registry.lookup("s" as never, "/f.txt")).toBeUndefined();
  });

  it("PathGate root 已是物理根（锁键面与门根同源归一——write/edit 装配前提）", () => {
    const gate = new PathGate(root);
    expect(gate.root).toBe(realpathSync(root));
  });
});
