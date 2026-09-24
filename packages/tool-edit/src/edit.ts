// edit 工具（docs/EDIT-TOOL.md）：精确文本替换——write 同款授权/门/CAS 管线（admitSession →
// realpath 锁键互斥 → FS_NOT_OBSERVED/FS_STALE_VERSION 门 → env.stat 判型）；BOM/行尾保真；
// applyEditsToNormalizedContent 判别联合应用；写前 signal.aborted 检查（aborted 判别态）；
// 写后自登记；diff/回显在锁外组装（两输入已定字符串无竞态，不拖长互斥持锁）。

import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv } from "@x-harness/exec-env";
import { admitSession, ObservedRegistry, PathGate } from "@x-harness/tool-core";
import type { RootOverrideOf, ExtraRootsOf } from "@x-harness/tool-core";
import { splitBom, detectLineEnding, normalizeToLF, restoreLineEndings, applyEditsToNormalizedContent } from "./edit-apply.ts";
import type { TextEdit } from "./edit-apply.ts";
import { generateDiffString } from "./edit-diff.ts";

export interface EditToolInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
}

export function createEditTool(input: EditToolInput): ToolDefinition {
  const { gate, observed, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  return {
    name: "edit",
    description:
      "Edit a file with exact text replacement (within the workspace root; the file must have been read in this session and unchanged since). Each edits[].oldText must match a unique, non-overlapping region of the original file — not after earlier edits are applied. If two changes touch the same block or nearby lines, merge them into one edit. Keep oldText as small as possible while still unique; do not pad it with large unchanged regions.",
    inputSchema: Type.Object({
      path: Type.String({ description: "File path (relative to workspace root or absolute inside it)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace. Must be unique in the original file and not overlap any other edits[].oldText in this call." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
        { minItems: 1, description: "One or more targeted replacements, all matched against the original file (not incrementally)." },
      ),
    }),
    execute: async (args, ctx: ToolExecContext) => edit({ gate, observed, env, ctx, extraRootsOf, rootOverrideOf, args: args as { path: string; edits: readonly TextEdit[] } }),
  };
}

/** locked 回调产物：锁内只做 I/O 与登记；diff 组装/回显在锁外 */
interface EditOutcome {
  readonly finalPayload: string | undefined;
  readonly baseText: string | undefined;
  readonly newText: string | undefined;
  readonly failure: { content: string; isError: true; aborted?: true } | undefined;
}

async function edit(input: { readonly gate: PathGate; readonly observed: ObservedRegistry; readonly env: ExecEnv; readonly extraRootsOf: ExtraRootsOf; readonly rootOverrideOf?: RootOverrideOf; readonly ctx: ToolExecContext; readonly args: { path: string; edits: readonly TextEdit[] } }): Promise<{ content: string; isError?: true; aborted?: true }> {
  const { gate, observed, env, ctx, args, extraRootsOf, rootOverrideOf } = input;
  if (PathGate.hasNul(args.path) || args.edits.some((e) => PathGate.hasNul(e.oldText) || PathGate.hasNul(e.newText))) {
    return { content: "NUL_IN_ARGUMENT: path/oldText/newText contains NUL", isError: true };
  }
  const admitted = await admitSession({ gate, realpath: env.realpath, session: ctx.session, extraRootsOf, rootOverrideOf, target: args.path });
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const path = admitted.path; // I/O 键：词法路径（观察登记/lookup 同键——read 侧登记面）
  const lockKey = await env.realpath(path); // 锁键：realpath（symlink 别名同锁）
  const outcome = await observed.locked(lockKey, () => editLocked({ observed, env, ctx, args, path }));
  if (outcome.failure !== undefined) return outcome.failure;
  const { finalPayload, baseText, newText } = outcome;
  if (finalPayload === undefined || baseText === undefined || newText === undefined) return { content: "invalid-tool-output", isError: true };
  const { diff } = generateDiffString(baseText, newText);
  const header = `Edited ${args.path} (${String(args.edits.length)} replacement${args.edits.length === 1 ? "" : "s"})`;
  return { content: diff === "" ? header : `${header}\n${diff}` };
}

async function editLocked(input: { readonly observed: ObservedRegistry; readonly env: ExecEnv; readonly ctx: ToolExecContext; readonly args: { path: string; edits: readonly TextEdit[] }; readonly path: string }): Promise<EditOutcome> {
  const { observed, env, ctx, args, path } = input;
  const failure = (content: string): EditOutcome => ({ finalPayload: undefined, baseText: undefined, newText: undefined, failure: { content, isError: true } });
  const st = await env.stat(path);
  if (!st.ok) {
    return failure(st.reason === "access_denied" ? `FS_ACCESS_DENIED: ${args.path} is not accessible` : `FS_NOT_FOUND: ${args.path} does not exist (read it first)`);
  }
  if (st.stat.kind === "dir") return failure(`FS_IS_DIRECTORY: ${args.path} is a directory`);
  if (st.stat.kind !== "file") return failure(`FS_NOT_REGULAR_FILE: ${args.path} is not a regular file`);
  const observedVersion = observed.lookup(ctx.session, path);
  if (observedVersion === undefined) return failure(`FS_NOT_OBSERVED: read ${args.path} before editing it`);
  if (ObservedRegistry.stale(observedVersion, { ...st.stat.version, hadBom: observedVersion.hadBom })) {
    return failure(`FS_STALE_VERSION: ${args.path} changed since it was read; re-read then retry`);
  }
  const raw = await readWholeFile(env, path);
  if (raw === undefined) return failure(`FS_READ_FAILED: i/o error while reading ${args.path}`);
  const { bom, text } = splitBom(raw);
  const ending = detectLineEnding(text);
  const normalized = normalizeToLF(text);
  const applied = applyEditsToNormalizedContent(normalized, args.edits, args.path);
  if (!applied.ok) return failure(applied.reason);
  if (ctx.signal.aborted) return { finalPayload: undefined, baseText: undefined, newText: undefined, failure: { content: "aborted before write", isError: true, aborted: true } };
  const finalPayload = bom + restoreLineEndings(applied.newContent, ending);
  const result = await env.writeFileAtomic(path, Buffer.from(finalPayload, "utf8"), { makeParents: false });
  if (!result.ok) return failure(writeFailText(result, args.path));
  // 写后自登记：edit→write 连续操作不被自己的门拒（rename 后 stat——ino 已换）
  observed.record(ctx.session, path, { ...result.stat.version, hadBom: bom !== "" });
  return { finalPayload, baseText: applied.baseContent, newText: applied.newContent, failure: undefined };
}

/** 整文件读取（openRead 句柄面流式拼装——版本取 fd fstat，与 read 工具同源实现面） */
async function readWholeFile(env: ExecEnv, path: string): Promise<string | undefined> {
  const open = await env.openRead(path);
  if (!open.ok) return undefined;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await open.handle.read();
      if (!chunk.ok) return undefined; // io_error 绝不折成空串（假空比错误危险）
      if (chunk.data === null) break;
      chunks.push(chunk.data);
    }
  } finally {
    await open.handle.close();
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const buffer = Buffer.alloc(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.toString("utf8");
}

function writeFailText(result: Extract<import("@x-harness/exec-env").WriteFileResult, { ok: false }>, display: string): string {
  if (result.reason === "write_failed") return `FS_WRITE_FAILED: ${result.detail}`;
  if (result.reason === "is_directory") return `FS_IS_DIRECTORY: ${display} is a directory`;
  if (result.reason === "not_regular") return `FS_NOT_REGULAR_FILE: ${display} is not a regular file`;
  if (result.reason === "access_denied") return `FS_ACCESS_DENIED: ${display} is not accessible`;
  return `FS_NOT_DIRECTORY_PARENT: parent path of ${display} is missing or not a directory`;
}
