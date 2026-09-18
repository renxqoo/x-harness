import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionId } from "@x-harness/session";
import { createArchiveReader } from "../archive.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-archive-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reader = () => createArchiveReader(root);

async function seedSession(
  id: string,
  header: Record<string, unknown> = { id, createdAt: 1 },
  lines: readonly string[] = [],
): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "header.json"), `${JSON.stringify(header)}\n`);
  if (lines.length > 0) {
    await writeFile(join(dir, "events.jsonl"), lines.map((line) => `${line}\n`).join(""));
  }
}

const ev0 = JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } });
const ev1 = JSON.stringify({
  type: "user/message",
  seq: 1,
  time: 2,
  data: { turn: 0, step: 0, content: [] },
  surfaceOp: "append",
});

describe("read（docs/SESSION.md §1.8 读侧规则）", () => {
  it("round-trip：header 与事件逐字节对账；返回值深冻", async () => {
    await seedSession("s1", undefined, [ev0, ev1]);
    const result = await reader().read("s1" as SessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.header).toEqual({ id: "s1", createdAt: 1 });
    expect(result.value.events).toEqual([JSON.parse(ev0), JSON.parse(ev1)]);
    expect(Object.isFrozen(result.value.events)).toBe(true);
    expect(Object.isFrozen(result.value.events[0])).toBe(true);
  });

  it("events.jsonl 缺失 = 空会话", async () => {
    await seedSession("empty");
    const result = await reader().read("empty" as SessionId);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.events).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ["header 缺失", () => mkdir(join(root, "nohdr"), { recursive: true }), "no-header:nohdr"],
    ["header 非合法 JSON", () => seedSession("badhdr", undefined, []).then(() => writeFile(join(root, "badhdr", "header.json"), "{")), "corrupt-header:badhdr"],
    ["id 不匹配", () => seedSession("mism", { id: "other", createdAt: 1 }), "corrupt-header:mism:id-mismatch"],
  ])("拒绝：%s → %s", async (_name, seed, expected) => {
    await seed();
    const result = await reader().read(expected.split(":")[1] as SessionId);
    expect(result).toEqual({ ok: false, reason: expected });
  });

  it("末行残缺（JSON.parse 失败）→ 跳过（崩溃痕迹）", async () => {
    const dir = join(root, "tail");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), `${JSON.stringify({ id: "tail", createdAt: 1 })}\n`);
    await writeFile(join(dir, "events.jsonl"), `${ev0}\n${ev1}\n{"type":"turn/start","seq":2`);
    const result = await reader().read("tail" as SessionId);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value.events).toHaveLength(2);
  });

  it("中间行损坏 / 中间空行 → 拒绝并带行号", async () => {
    await seedSession("mid", undefined, [ev0, "{broken", ev1]);
    expect(await reader().read("mid" as SessionId)).toEqual({ ok: false, reason: "corrupt:mid:line1" });
    await seedSession("blank", undefined, [ev0, "", ev1]);
    expect(await reader().read("blank" as SessionId)).toEqual({ ok: false, reason: "corrupt:blank:line1" });
  });

  it("事件卷非法（seq 断档 / replace 悬空）→ validateSessionEvents 理由", async () => {
    const gap = JSON.stringify({ type: "turn/start", seq: 5, time: 1, data: { turn: 0 } });
    await seedSession("gap", undefined, [gap]);
    const gapResult = await reader().read("gap" as SessionId);
    expect(gapResult.ok).toBe(false);
    if (!gapResult.ok) expect(gapResult.reason).toContain("corrupt-envelope:0:seq");

    const dangling = JSON.stringify({
      type: "user/message",
      seq: 0,
      time: 1,
      data: { turn: 0, step: 0, content: [] },
      surfaceOp: { op: "replace", startSeq: 9, endSeq: 9 },
    });
    await seedSession("dang", undefined, [dangling]);
    const dangResult = await reader().read("dang" as SessionId);
    expect(dangResult.ok).toBe(false);
    if (!dangResult.ok) expect(dangResult.reason).toContain("corrupt-surface:0");
  });

  it("路径越权 id → invalid-id", async () => {
    expect(await reader().read("../x" as SessionId)).toEqual({ ok: false, reason: "invalid-id:../x" });
  });
});

describe("list（docs/SESSION.md §1.8——只认 header.json）", () => {
  it("有 header 的目录才列出；空目录/孤儿事件档/文件不列", async () => {
    await seedSession("a");
    await seedSession("b", undefined, [ev0]);
    await mkdir(join(root, "empty-dir"), { recursive: true });
    const orphan = join(root, "orphan");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "events.jsonl"), `${ev0}\n`);
    await writeFile(join(root, "plain-file"), "x");
    expect(reader().list()).toEqual(["a", "b"]);
  });

  it("root 不存在（ENOENT）→ 空列表；无读权限（EACCES）→ 上抛不静默（症状：曾折叠为空列表）", async () => {
    expect(createArchiveReader(join(root, "nope")).list()).toEqual([]);
    await seedSession("a");
    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o000);
    try {
      expect(() => createArchiveReader(root).list()).toThrow();
    } finally {
      await chmod(root, 0o700);
    }
  });
});
