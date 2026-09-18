// write 工具（docs/TOOLBOX.md §3 + docs/EXEC-ENV.md §3）：观察门+版本 CAS（会话键控；版本由
// ExecEnv 产出——write 侧 env.stat）；同路径进程内互斥；原子写 env.writeFileAtomic（D1 mode
// 承袭、temp+rename、失败清残留——均在 env 实现）；BOM round-trip；写后自登记。

import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv } from "@x-harness/exec-env";
import { PathGate } from "./paths.ts";
import type { ExtraRootsOf } from "./toolbox.ts";
import { ObservedRegistry } from "./observed.ts";
import type { WriteFileResult } from "@x-harness/exec-env";

const BOM = "﻿";

export interface WriteToolInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
}

export function createWriteTool(input: WriteToolInput): ToolDefinition {
  const { gate, observed, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  return {
    name: "write",
    description:
      "Write a whole file (create or overwrite) within the workspace root. Overwriting an existing file requires reading it first in the same session (and it must not have changed since). Parent directories are created automatically.",
    inputSchema: Type.Object({
      path: Type.String({ description: "File path (relative to workspace root or absolute inside it)" }),
      content: Type.String({ description: "Full file content (empty string writes an empty file)" }),
    }),
    execute: async (args, ctx: ToolExecContext) => write({ gate, observed, env, ctx, extraRootsOf, args: args as { path: string; content: string } }),
  };
}

async function write(input: { readonly gate: PathGate; readonly observed: ObservedRegistry; readonly env: ExecEnv; readonly extraRootsOf: ExtraRootsOf; readonly ctx: ToolExecContext; readonly args: { path: string; content: string } }): Promise<{ content: string; isError?: true }> {
  const { gate, observed, env, ctx, args, extraRootsOf } = input;
  if (PathGate.hasNul(args.path) || PathGate.hasNul(args.content)) {
    return { content: "NUL_IN_ARGUMENT: path/content contains NUL", isError: true };
  }
  const admitted = await gate.admit(args.path, env.realpath, extraRootsOf(ctx.session));
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const path = admitted.path;
  return observed.locked(path, async () => {
    const st = await env.stat(path);
    let preExisting = false;
    let observedVersion: ReturnType<ObservedRegistry["lookup"]> = undefined;
    if (st.ok) {
      if (st.stat.kind === "dir") return { content: `FS_IS_DIRECTORY: ${args.path} is a directory`, isError: true };
      if (st.stat.kind !== "file") return { content: `FS_NOT_REGULAR_FILE: ${args.path} is not a regular file`, isError: true }; // FIFO/socket 同拒（rename 语义只对常规文件成立）
      preExisting = true;
      observedVersion = observed.lookup(ctx.session, path);
      if (observedVersion === undefined) {
        return { content: `FS_NOT_OBSERVED: read ${args.path} before overwriting it`, isError: true };
      }
      if (ObservedRegistry.stale(observedVersion, { ...st.stat.version, hadBom: observedVersion.hadBom })) {
        return { content: `FS_STALE_VERSION: ${args.path} changed since it was read; re-read then retry`, isError: true };
      }
    } else if (st.reason === "access_denied") {
      return { content: `FS_ACCESS_DENIED: ${args.path} is not accessible`, isError: true };
    }
    const hadBom = preExisting && observedVersion !== undefined && observedVersion.hadBom;
    const payload = hadBom ? BOM + args.content : args.content;
    const result = await env.writeFileAtomic(path, Buffer.from(payload, "utf8"), { makeParents: true });
    if (!result.ok) return { content: writeFailText(result, args.path), isError: true };
    // 写后自登记：write→write 连续写不被自己的门拒（rename 后 stat——ino 已换）
    observed.record(ctx.session, path, { ...result.stat.version, hadBom });
    const lines = payload === "" ? 0 : payload.split("\n").length;
    return { content: `Wrote ${args.path} (${String(lines)} line${lines === 1 ? "" : "s"})` };
  });
}

function writeFailText(result: Extract<WriteFileResult, { ok: false }>, display: string): string {
  if (result.reason === "write_failed") return `FS_WRITE_FAILED: ${result.detail}`; // 先收窄带 detail 的变体
  if (result.reason === "is_directory") return `FS_IS_DIRECTORY: ${display} is a directory`;
  if (result.reason === "not_regular") return `FS_NOT_REGULAR_FILE: ${display} is not a regular file`;
  if (result.reason === "access_denied") return `FS_ACCESS_DENIED: ${display} is not accessible`;
  return `FS_NOT_DIRECTORY_PARENT: parent path of ${display} is missing or not a directory`;
}

export { BOM as WRITE_BOM };
