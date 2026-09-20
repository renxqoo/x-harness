// /export 实现（docs/CLI.md §2.3）：flush 屏障先行（turn 收尾的 flush 为异步告警式，
// idle 不承诺字节已 fsync——直接拷会拷到滞后卷）→ 拷贝磁盘卷；--no-session 会话从内存
// events() 序列化；目标已存在拒绝（防误覆盖）。

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Result } from "@x-harness/core";
import type { Session, SessionStore } from "@x-harness/session";

export async function exportSession(input: {
  readonly store: SessionStore;
  readonly sessionRoot: string;
  readonly session: Session;
  readonly persist: boolean;
  readonly target: string;
}): Promise<Result<{ readonly path: string }>> {
  const { store, session, target } = input;
  const exists = await stat(target).then(() => true, () => false);
  if (exists) return { ok: false, reason: `refusing to overwrite existing file: ${target}` };
  const flushed = await store.flush(session.id);
  if (!flushed.ok) return { ok: false, reason: flushed.reason };
  try {
    await mkdir(dirname(target), { recursive: true });
  } catch (error) {
    return { ok: false, reason: `export failed: ${error instanceof Error ? error.message : "cannot create target directory"}` };
  }
  if (input.persist) {
    const source = join(input.sessionRoot, session.id, "events.jsonl");
    try {
      await copyFile(source, target);
    } catch (error) {
      return { ok: false, reason: `export failed: ${error instanceof Error ? error.message : "io error"}` };
    }
    return { ok: true, value: { path: target } };
  }
  const lines = session.events().map((event) => `${JSON.stringify(event)}\n`).join("");
  try {
    await writeFile(target, lines, { flag: "wx" });
  } catch (error) {
    return { ok: false, reason: `export failed: ${error instanceof Error ? error.message : "io error"}` };
  }
  return { ok: true, value: { path: target } };
}
