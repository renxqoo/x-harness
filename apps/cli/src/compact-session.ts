// /compact 实现（docs/CLI.md §2.3）：LLM 总结 + surface replace 折叠。
// 关键不变量（对抗审查 #1）：必须保留 surface 首个含 text 的节点（system 锚点）——
// agent-loop 每 turn 以它为系统提示词锚点，折叠它会在下一 turn 被锚点覆写机制摧毁摘要。
// 摘要落 user/message（content 块），replace 区间 = 锚点之后到尾部；空区间 no-op。

import type { Context } from "@x-harness/core";
import { llmRuntime } from "@x-harness/llm";
import type { Session, SurfaceNode } from "@x-harness/session";

export type CompactOutcome =
  | { readonly kind: "folded"; readonly fromSeq: number; readonly toSeq: number }
  | { readonly kind: "noop" }
  | { readonly kind: "failed"; readonly reason: string };

const SUMMARY_INSTRUCTION = "Summarize the conversation above compactly for future context: key decisions, current task state, open items, and any file paths or identifiers that matter. Output only the summary.";

/** 锚点 = surface 首个 data.text 在场节点（system/message） */
function anchorOf(surface: readonly SurfaceNode[]): SurfaceNode | undefined {
  return surface.find((node) => (node.event.data as { text?: string }).text !== undefined);
}

interface SummarizeInput {
  readonly ctx: Context;
  readonly session: Session;
  readonly dial: { readonly provider?: string; readonly model?: string };
  readonly instructions: string | undefined;
  readonly signal: AbortSignal;
}

async function summarize(input: SummarizeInput): Promise<string | undefined> {
  const runtime = input.ctx.use(llmRuntime);
  const ask = input.instructions === undefined || input.instructions.trim() === "" ? SUMMARY_INSTRUCTION : `${input.instructions}\n\n${SUMMARY_INSTRUCTION}`;
  const messages = [
    ...input.session.deriveMessages(),
    { role: "user" as const, content: [{ type: "text" as const, text: ask }] },
  ];
  let text = "";
  for await (const chunk of runtime.stream({ model: input.dial.model ?? "", ...(input.dial.provider !== undefined ? { provider: input.dial.provider } : {}), tools: [], messages, signal: input.signal })) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish" && chunk.finish.kind === "error") return undefined;
  }
  return text.trim().length > 0 ? text : undefined;
}

export async function compactSession(input: {
  readonly ctx: Context;
  readonly session: Session;
  readonly dial: { readonly provider?: string; readonly model?: string };
  readonly instructions?: string;
  readonly signal: AbortSignal;
}): Promise<CompactOutcome> {
  const { ctx, session } = input;
  const surface = session.surface();
  const anchor = anchorOf(surface);
  const anchorIndex = anchor === undefined ? -1 : surface.indexOf(anchor);
  const last = surface[surface.length - 1];
  // 无锚点（空会话）或锚点即尾节点（无历史可折叠）→ no-op
  if (anchor === undefined || anchorIndex === -1 || last === undefined || last.seq === anchor.seq) {
    return { kind: "noop" };
  }
  const summary = await summarize({ ctx, session, dial: input.dial, instructions: input.instructions, signal: input.signal });
  if (summary === undefined) return { kind: "failed", reason: "summary generation failed" };
  if (input.signal.aborted) return { kind: "failed", reason: "cancelled" };
  const first = surface[anchorIndex + 1];
  if (first === undefined) return { kind: "noop" };
  const appended = session.append(
    "user/message",
    { turn: (first.event.data as { turn?: number }).turn ?? 0, step: (first.event.data as { step?: number }).step ?? 0, content: [{ type: "text", text: summary }] },
    { surfaceOp: { op: "replace", startSeq: first.seq, endSeq: last.seq } },
  );
  if (!appended.ok) return { kind: "failed", reason: appended.reason };
  return { kind: "folded", fromSeq: first.seq, toSeq: last.seq };
}
