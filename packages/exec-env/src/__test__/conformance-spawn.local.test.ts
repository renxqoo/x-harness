// spawn 面 local-only conformance（docs/EXEC-ENV.md §7）：真子进程——exited 形状、流消费、
// kill 幂等、settle 孙进程有界收敛（组长退出≠组清空）、spawn 失败判别。内核级语义本腿权威。

import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createLocalEnv } from "../local/env.ts";

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
  }
  return text + decoder.decode();
}

describe("spawn conformance（local 真进程）", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xh-envsp-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("echo：exited {code:0}；stdout 双流可消费", async () => {
    const env = createLocalEnv(root);
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "printf hi"] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const out = await drain(spawned.proc.stdout);
    expect(out).toBe("hi");
    expect(await drain(spawned.proc.stderr)).toBe("");
    const exited = await spawned.proc.exited;
    expect(exited.code).toBe(0);
    expect(exited.signal).toBeNull();
    await spawned.proc.settled;
  });

  it("非零退出码可见；stderr 流分立", async () => {
    const env = createLocalEnv(root);
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "echo err >&2; exit 3"] });
    if (!spawned.ok) throw new Error("spawn failed");
    expect(await drain(spawned.proc.stderr)).toBe("err\n");
    const exited = await spawned.proc.exited;
    expect(exited.code).toBe(3);
    await spawned.proc.settled;
  });

  it("信号死亡：kill -9 自杀 → exited 形状可判别（code null 或 128+n——渲染层折算）", async () => {
    const env = createLocalEnv(root);
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "kill -9 $$"] });
    if (!spawned.ok) throw new Error("spawn failed");
    const exited = await spawned.proc.exited;
    const dead = (exited.code === null && exited.signal !== null) || exited.code === 137;
    expect(dead).toBe(true);
    await spawned.proc.settled;
  });

  it("kill 幂等不 throw；TERM 杀组长后 settled 有界收敛", async () => {
    const env = createLocalEnv(root);
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "sleep 30"] });
    if (!spawned.ok) throw new Error("spawn failed");
    await spawned.proc.kill("term");
    await spawned.proc.kill("term"); // 幂等
    const exited = await spawned.proc.exited;
    expect(exited.code).not.toBe(0); // 被杀，非正常退出
    await spawned.proc.settled;
    await spawned.proc.kill("kill"); // 已死后 no-op 不 throw
  });

  it("settle：组长速死孙进程仍活——有界收敛（5s 兜底 KILL）后组清空", async () => {
    const env = createLocalEnv(root);
    const marker = join(root, "straggler.marker");
    // 孙进程 TERM 免疫且沉睡超过收敛上限（30s）——若 settle 兜底 SIGKILL 失效，marker 会在收尾后出现
    const spawned = await env.spawn({
      argv: ["/bin/sh", "-c", `(trap '' TERM; sleep 30 && touch ${JSON.stringify(marker)}) & exit 0`],
    });
    if (!spawned.ok) throw new Error("spawn failed");
    const started = Date.now();
    await spawned.proc.settled;
    expect(Date.now() - started).toBeLessThan(7_000); // 有界（≤5s 轮询上限+余量）
    await new Promise((r) => {
      setTimeout(r, 300); // KILL 落定余量
    });
    const wrote = await readFile(marker, "utf8").then(
      () => true,
      () => false,
    );
    expect(wrote).toBe(false); // 孙进程被 settle 兜底杀净——无泄漏
  }, 10_000);

  it("spawn ENOENT：argv[0] 缺席 → not_found 判别", async () => {
    const env = createLocalEnv(root);
    const spawned = await env.spawn({ argv: ["/no/such/binary-definitely-missing"] });
    expect(spawned.ok).toBe(false);
    if (!spawned.ok) expect(spawned.reason.kind).toBe("not_found");
  });

  it("cwd 生效：workdir 内产生文件", async () => {
    const env = createLocalEnv(root);
    const work = join(root, "work");
    await mkdir(work, { recursive: true });
    const spawned = await env.spawn({ argv: ["/bin/sh", "-c", "pwd > where.txt"], cwd: work });
    if (!spawned.ok) throw new Error("spawn failed");
    await spawned.proc.exited;
    const where = await readFile(join(work, "where.txt"), "utf8");
    expect(where.trim()).toBe(await env.realpath(work));
    await spawned.proc.settled;
  });
});
