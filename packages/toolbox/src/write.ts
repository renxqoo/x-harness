// write 工具（docs/TOOLBOX.md §3）：观察门+版本 CAS（会话键控）；同路径进程内互斥；
// 原子写 temp+rename（失败无半截无残留；rename 替换 symlink 本身）；BOM round-trip；写后自登记。

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import { PathGate } from "./paths.ts";
import { ObservedRegistry } from "./observed.ts";

const BOM = "﻿";

export function createWriteTool(gate: PathGate, observed: ObservedRegistry): ToolDefinition {
  return {
    name: "write",
    description:
      "Write a whole file (create or overwrite) within the workspace root. Overwriting an existing file requires reading it first in the same session (and it must not have changed since). Parent directories are created automatically.",
    inputSchema: Type.Object({
      path: Type.String({ description: "File path (relative to workspace root or absolute inside it)" }),
      content: Type.String({ description: "Full file content (empty string writes an empty file)" }),
    }),
    execute: async (args, ctx: ToolExecContext) => write({ gate, observed, ctx, args: args as { path: string; content: string } }),
  };
}

async function write(input: { readonly gate: PathGate; readonly observed: ObservedRegistry; readonly ctx: ToolExecContext; readonly args: { path: string; content: string } }): Promise<{ content: string; isError?: true }> {
  const { gate, observed, ctx, args } = input;
  if (PathGate.hasNul(args.path) || PathGate.hasNul(args.content)) {
    return { content: "NUL_IN_ARGUMENT: path/content contains NUL", isError: true };
  }
  const admitted = gate.admit(args.path);
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const path = admitted.path;
  return observed.locked(path, async () => {
    const preExisting = existsSync(path);
    let observedVersion = undefined as ReturnType<ObservedRegistry["lookup"]>;
    if (preExisting) {
      const st = statSync(path);
      if (st.isDirectory()) return { content: `FS_IS_DIRECTORY: ${args.path} is a directory`, isError: true };
      if (!st.isFile()) return { content: `FS_NOT_REGULAR_FILE: ${args.path} is not a regular file`, isError: true }; // FIFO/socket 同拒（rename 语义只对常规文件成立）
      observedVersion = observed.lookup(ctx.session, path);
      if (observedVersion === undefined) {
        return { content: `FS_NOT_OBSERVED: read ${args.path} before overwriting it`, isError: true };
      }
      const current = ObservedRegistry.versionOf(path, observedVersion.hadBom);
      if (ObservedRegistry.stale(observedVersion, current)) {
        return { content: `FS_STALE_VERSION: ${args.path} changed since it was read; re-read then retry`, isError: true };
      }
    }
    const payload = preExisting && observedVersion !== undefined && observedVersion.hadBom ? BOM + args.content : args.content;
    const failure = atomicWrite(path, payload);
    if (failure !== undefined) return { content: `FS_WRITE_FAILED: ${failure}`, isError: true };
    // 写后自登记：write→write 连续写不被自己的门拒（rename 后 stat——ino 已换）
    observed.record(ctx.session, path, ObservedRegistry.versionOf(path, preExisting && observedVersion !== undefined && observedVersion.hadBom));
    const lines = payload === "" ? 0 : payload.split("\n").length;
    return { content: `Wrote ${args.path} (${String(lines)} line${lines === 1 ? "" : "s"})` };
  });
}

/** 写入原语（可注入——部分写语义由调用方循环续写；注入测试模拟短写/中途失败）。
 *  契约：从 buf 的 offset 写到末尾，返回实写字节数（可短写） */
export type ByteSink = (fd: number, buf: Buffer, offset: number) => number;

/** 同目录 temp + rename；失败清理 temp（可捕获失败无残留；crash 残留落档接受） */
function atomicWrite(path: string, payload: string, sink: ByteSink = writeSync): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return describe(error);
  }
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      const buf = Buffer.from(payload, "utf8");
      let written = 0;
      while (written < buf.length) {
        written += sink(fd, buf, written); // 部分写循环（ENOSPC 半截不晋升）
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path); // POSIX 原子替换；落在 symlink 上替换链接本身
    return undefined;
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* 清理失败不再叠加 */
    }
    return describe(error);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { atomicWrite, BOM as WRITE_BOM, statSync as writeStatSync };
export type { Stats };
