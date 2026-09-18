import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { isEexistError, isPermanentRejection, openSessionWriter } from "../writer.ts";

let root: string;
const header: SessionHeader = { id: "w1" as SessionId, createdAt: 1 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-writer-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev0 = { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } } as SessionEvent;
const ev1 = {
  type: "user/message",
  seq: 1,
  time: 2,
  data: { turn: 0, step: 0, content: [] },
  surfaceOp: "append",
} as SessionEvent;

async function writeLines(dir: string, lines: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.jsonl"), lines.map((line) => `${line}\n`).join(""));
}

describe("openSessionWriter 全新路径（docs/SESSION-RESUME §1.4 Level 1）", () => {
  it("ax 成功：写 header、建空 events；append + sync 落盘；close 后内容可读", async () => {
    const { writer } = await openSessionWriter(root, header, []);
    expect(JSON.parse(await readFile(join(root, "header.json"), "utf8"))).toEqual(header);
    await writer.append([`${JSON.stringify(ev0)}\n`, `${JSON.stringify(ev1)}\n`]);
    await writer.sync();
    await writer.close();
    const lines = (await readFile(join(root, "events.jsonl"), "utf8")).split("\n");
    expect(lines[0]).toBe(JSON.stringify(ev0));
    expect(lines[1]).toBe(JSON.stringify(ev1));
  });

  it("空数组 append = 纯 sync 屏障", async () => {
    const { writer } = await openSessionWriter(root, header, []);
    await writer.append([]);
    await writer.sync();
    await writer.close();
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe("");
  });

  it("events 已存在且无 header（孤儿事件档）→ archive-orphan-events，旧档不动", async () => {
    await writeLines(root, [JSON.stringify(ev0)]);
    const error = await openSessionWriter(root, header, []).catch((e: unknown) => e);
    expect(isPermanentRejection(error)).toBe(true);
    expect((error as Error).message).toMatch(/^archive-orphan-events:/);
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe(`${JSON.stringify(ev0)}\n`);
  });

  it("header 已存在且不等 → wx EEXIST 撤销空 events，旧 header 零损毁", async () => {
    const oldHeader = `${JSON.stringify({ id: "w1", createdAt: 0 })}\n`;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), oldHeader);
    const error = await openSessionWriter(root, header, []).catch((e: unknown) => e);
    expect(isEexistError(error)).toBe(true);
    expect(await readFile(join(root, "header.json"), "utf8")).toBe(oldHeader);
    await expect(readFile(join(root, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("孤儿 header（header 在、events 缺，外部损坏态）→ wx EEXIST 回滚拒绝，旧 header 零损毁", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    const error = await openSessionWriter(root, header, [ev0]).catch((e: unknown) => e);
    expect(isEexistError(error)).toBe(true);
    expect(await readFile(join(root, "header.json"), "utf8")).toBe(`${JSON.stringify(header)}\n`);
    await expect(readFile(join(root, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isEexistError 对非 fs 错误 → false", () => {
    expect(isEexistError(new Error("plain"))).toBe(false);
    expect(isEexistError(undefined)).toBe(false);
  });
});

describe("openSessionWriter 续写路径（docs/SESSION-RESUME §1.4 Level 2）", () => {
  it("磁盘卷 == 当前日志前缀且 header 相等 → 'a' 续写，prefixLength = 磁盘长度", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    await writeLines(root, [JSON.stringify(ev0)]);
    const opened = await openSessionWriter(root, header, [ev0, ev1]);
    expect(opened.prefixLength).toBe(1);
    await opened.writer.append([`${JSON.stringify(ev1)}\n`]);
    await opened.writer.sync();
    await opened.writer.close();
    const lines = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toEqual([JSON.stringify(ev0), JSON.stringify(ev1)]);
  });

  it("前缀不符（磁盘事件与当前日志不同）→ archive-prefix-mismatch，旧档不动", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    await writeLines(root, [JSON.stringify(ev1)]);
    const error = await openSessionWriter(root, header, [ev0, ev1]).catch((e: unknown) => e);
    expect(isPermanentRejection(error)).toBe(true);
    expect((error as Error).message).toMatch(/^archive-prefix-mismatch:/);
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe(`${JSON.stringify(ev1)}\n`);
  });

  it("header 不等（键序不同但同值应相等；值不同应拒）", async () => {
    await mkdir(root, { recursive: true });
    await writeLines(root, [JSON.stringify(ev0)]);
    // 同值不同键序 → 规范化相等 → 续写
    await writeFile(join(root, "header.json"), `${JSON.stringify({ createdAt: 1, id: "w1" })}\n`);
    const ok = await openSessionWriter(root, header, [ev0]);
    expect(ok.prefixLength).toBe(1);
    await ok.writer.close();
    // 值不同（createdAt）→ session-id-reused
    await writeFile(join(root, "header.json"), `${JSON.stringify({ id: "w1", createdAt: 9 })}\n`);
    const error = await openSessionWriter(root, header, [ev0]).catch((e: unknown) => e);
    expect(isPermanentRejection(error)).toBe(true);
    expect((error as Error).message).toMatch(/^session-id-reused:/);
  });

  it("残尾半行 → 截断丢弃 + 续写后读全量（docs/SESSION-RESUME 审查 #1 态一）", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(ev0)}\n{"type":"turn/st`);
    const opened = await openSessionWriter(root, header, [ev0, ev1]);
    expect(opened.prefixLength).toBe(1);
    await opened.writer.append([`${JSON.stringify(ev1)}\n`]);
    await opened.writer.sync();
    await opened.writer.close();
    const lines = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toEqual([JSON.stringify(ev0), JSON.stringify(ev1)]);
  });

  it("残尾完整行缺尾换行 → 收编进 D 由 pending 重写（态二）", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    // ev1 完整但缺 \n：截断后 D=[ev0]，k=1，ev1 在 pending 重写
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(ev0)}\n${JSON.stringify(ev1)}`);
    const opened = await openSessionWriter(root, header, [ev0, ev1]);
    expect(opened.prefixLength).toBe(1);
    await opened.writer.append([`${JSON.stringify(ev1)}\n`]);
    await opened.writer.sync();
    await opened.writer.close();
    const lines = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toEqual([JSON.stringify(ev0), JSON.stringify(ev1)]);
  });

  it("中间空行 / 中间坏行 → archive-corrupt（修复只针对尾部）", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "header.json"), `${JSON.stringify(header)}\n`);
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(ev0)}\n\n${JSON.stringify(ev1)}\n`);
    const error = await openSessionWriter(root, header, [ev0, ev1]).catch((e: unknown) => e);
    expect(isPermanentRejection(error)).toBe(true);
    expect((error as Error).message).toMatch(/^archive-corrupt:.*:blank-line$/);
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(ev0)}\n{broken\n${JSON.stringify(ev1)}\n`);
    const error2 = await openSessionWriter(root, header, [ev0, ev1]).catch((e: unknown) => e);
    expect((error2 as Error).message).toMatch(/^archive-corrupt:.*:line1$/);
  });
});
