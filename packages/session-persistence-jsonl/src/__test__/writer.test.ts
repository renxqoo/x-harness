import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionHeader, SessionId } from "@x-harness/session";
import { isEexistError, openSessionWriter } from "../writer.ts";

let root: string;
const header: SessionHeader = { version: 1, id: "w1" as SessionId, createdAt: 1 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-writer-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("openSessionWriter（docs/SESSION.md §1.8 排他创建）", () => {
  it("正常打开：写 header.json、建空 events.jsonl；append + sync 落盘；close 后可校验内容", async () => {
    const writer = await openSessionWriter(root, header);
    const headerText = await readFile(join(root, "header.json"), "utf8");
    expect(JSON.parse(headerText)).toEqual(header);
    await writer.append([`${JSON.stringify({ seq: 0 })}\n`, `${JSON.stringify({ seq: 1 })}\n`]);
    await writer.sync();
    await writer.close();
    const lines = (await readFile(join(root, "events.jsonl"), "utf8")).split("\n");
    expect(lines[0]).toBe(JSON.stringify({ seq: 0 }));
    expect(lines[1]).toBe(JSON.stringify({ seq: 1 }));
  });

  it("空数组 append = 纯 sync 屏障（不写行）", async () => {
    const writer = await openSessionWriter(root, header);
    await writer.append([]);
    await writer.sync();
    await writer.close();
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe("");
  });

  it("events.jsonl 已存在（同 id 重用）→ ax 阶段 EEXIST，header 不被触碰", async () => {
    await writeFile(join(root, "events.jsonl"), "old\n");
    const openError = await openSessionWriter(root, header).catch((error: unknown) => error);
    expect(isEexistError(openError)).toBe(true);
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe("old\n");
  });

  it("header.json 已存在 → wx 阶段 EEXIST，撤销刚建的空 events.jsonl，旧 header 零损毁", async () => {
    await mkdir(root, { recursive: true });
    const oldHeader = `${JSON.stringify({ version: 1, id: "w1", createdAt: 0 })}\n`;
    await writeFile(join(root, "header.json"), oldHeader);
    const openError = await openSessionWriter(root, header).catch((error: unknown) => error);
    expect(isEexistError(openError)).toBe(true);
    expect(await readFile(join(root, "header.json"), "utf8")).toBe(oldHeader);
    await expect(readFile(join(root, "events.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isEexistError 对非 fs 错误 → false", () => {
    expect(isEexistError(new Error("plain"))).toBe(false);
    expect(isEexistError(undefined)).toBe(false);
  });
});
