// compact 核心流程（docs/COMPACTION.md §1.1 落账形状）：切口 → 摘要 side-call →
// 组装（正文 + 文件账本标签 + 续航注入语）→ replace 位置区间落账。全软失败判别联合，
// 不抛业务异常；上一份摘要（含 autocompact L2 账本）位于区间首位、被本份替换——
// 累积更新链。

import type { LlmRuntime } from "@x-harness/llm";
import type { SessionId, SessionStore, SurfaceNode } from "@x-harness/session";
import { estimateText } from "@x-harness/token-meter";
import { appendSummarySection, stripSummarySection } from "./section.ts";
import type { SummarySectionProvider } from "./tokens.ts";
import { findCutPoint, USER_QUOTE_TOKENS } from "./cut.ts";
import {
  accumulateFileOps,
  computeFileLists,
  formatFileOperations,
  hasPathBearingToolUse,
  parseFileOperations,
  type FileToolNames,
} from "./file-ops.ts";
import { AUTO_CONTINUATION_NOTE } from "./prompts.ts";
import { serializeConversation } from "./serialize.ts";
import { summarize, type SummarizerFace, type SummarizeOutcome } from "./summarize.ts";

export type CompactTrigger = "manual" | "auto" | "emergency";

export type CompactionSkipReason =
  | "session-unknown"
  | "summarizer-unconfigured"
  | "llm-unavailable"
  | "no-cut-point"
  | "summary-input-budget-exhausted"
  | "summarize-failed"
  | "summary-truncated"
  | "summary-empty"
  | "replace-failed"
  | "aborted";

export type CompactionResult =
  | { readonly ok: true; readonly replacedNodes: number; readonly summaryTokens: number }
  | { readonly ok: false; readonly reason: CompactionSkipReason };

export interface ResolvedConfig {
  readonly contextWindow: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly fileTools: FileToolNames;
  readonly idleTimeoutMs: number;
  readonly summarizer: SummarizerFace | undefined;
  /** 工厂级聚焦指令（每次摘要附加在提示词尾；逐调用指令在场时以其为准——参照系
   *  「同一焦点两次表述互相稀释」裁决） */
  readonly customInstructions?: string;
}

export interface CompactFields {
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly customInstructions?: string;
  readonly keepRecentTokens?: number;
  readonly turn: number;
  readonly step: number;
  /** 触发上下文的取消信号（水位/自愈 = turn signal；手动可缺席）——联动摘要拨号 */
  readonly signal?: AbortSignal;
}

export interface LandedPayload {
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly replacedNodes: number;
  readonly summaryTokens: number;
}

export interface CompactDeps {
  readonly store: SessionStore;
  readonly llm: LlmRuntime | undefined;
  readonly config: ResolvedConfig;
  /** 摘要注入段停靠（docs/COMPACTION.md §15）：运行期拉取（装配序无关/缺席不注入） */
  readonly trySection: () => SummarySectionProvider | undefined;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly landed: (payload: LandedPayload) => void;
  /** per-session 单飞行账本（join 语义）：并发 compact 汇入在飞者共享同一结果——
   *  消灭参照系「并发 compact 双落账」缺口；identity 删除防同 id 重生会话误摘新主 */
  readonly inflight: Map<SessionId, Promise<CompactionResult>>;
}

/** 摘要终态 → 跳过理由词表（闭射——新终态必须显式入表） */
const OUTCOME_REASONS: Readonly<Record<Exclude<SummarizeOutcome, { ok: true }>["reason"], CompactionSkipReason>> = {
  "budget-exhausted": "summary-input-budget-exhausted",
  empty: "summary-empty",
  failed: "summarize-failed",
  truncated: "summary-truncated",
  aborted: "aborted",
};

/** 上一份摘要节点：投影中末个 replace 型 user/message（compaction 摘要与 autocompact
 *  L2 账本都算——累积链跨层连续；L2 账本文本过 parseFileOperations 自然得空清单） */
export function previousSummaryOf(nodes: readonly SurfaceNode[]): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === undefined || node.event.type !== "user/message") continue;
    const op = node.event.surfaceOp;
    if (typeof op !== "object" || op === null) continue;
    for (const block of node.event.data.content) {
      if (block.type === "text") return block.text;
    }
    return "";
  }
  return undefined;
}

/** 单飞行（join 语义）：在飞者直接汇入（水位/自愈/手动并发共用）；落定后 identity
 *  删除（同 id 重生会话的在新飞入不会被旧 finally 误摘） */
export function runCompact(deps: CompactDeps, fields: CompactFields): Promise<CompactionResult> {
  const existing = deps.inflight.get(fields.session);
  if (existing !== undefined) return existing;
  const session = deps.store.get(fields.session);
  if (session === undefined) return Promise.resolve({ ok: false, reason: "session-unknown" });
  const flight = compactSession(deps, fields, session.surface()).finally(() => {
    if (deps.inflight.get(fields.session) === flight) deps.inflight.delete(fields.session);
  });
  deps.inflight.set(fields.session, flight);
  return flight;
}

/** 摘要区间载荷：区间节点 + 上一份摘要（跨函数传递的参数对象——缺抽象即封装） */
interface Span {
  readonly nodes: readonly SurfaceNode[];
  readonly previousSummary: string | undefined;
}

/** 摘要区间的文件账本（含上一份摘要的既有清单） */
function fileListsOf(deps: CompactDeps, session: SessionId, span: Span) {
  const previousLists =
    span.previousSummary !== undefined ? parseFileOperations(span.previousSummary) : { readFiles: [], modifiedFiles: [] };
  const lists = computeFileLists(accumulateFileOps(span.nodes, previousLists, deps.config.fileTools));
  if (lists.readFiles.length === 0 && lists.modifiedFiles.length === 0 && hasPathBearingToolUse(span.nodes)) {
    deps.warn(session, "file-ledger-empty"); // 有 path 型操作而清单为空——换名对齐信号
  }
  return lists;
}

/** 摘要 side-call 入参（face/llm 在场性由调用方前置裁决并以参数传递——理由词区分） */
interface SummarizeCall {
  readonly deps: CompactDeps;
  readonly fields: CompactFields;
  readonly span: Span;
  readonly face: SummarizerFace;
  readonly llm: LlmRuntime;
}

/** 聚焦指令：逐调用在场以其为准（参照系「同一焦点两次表述互相稀释」裁决），否则工厂级 */
function focusOf(deps: CompactDeps, fields: CompactFields): string | undefined {
  if (fields.customInstructions !== undefined) return fields.customInstructions;
  return deps.config.customInstructions;
}

async function summarizeSpan(call: SummarizeCall): Promise<SummarizeOutcome> {
  const { deps, fields, span, face, llm } = call;
  const focus = focusOf(deps, fields);
  return summarize({
    llm,
    face,
    reserveTokens: deps.config.reserveTokens,
    conversation: serializeConversation(span.nodes),
    ...(span.previousSummary !== undefined ? { previousSummary: span.previousSummary } : {}),
    ...(focus !== undefined ? { customInstructions: focus } : {}),
    signal: fields.signal ?? new AbortController().signal,
    idleTimeoutMs: deps.config.idleTimeoutMs,
  });
}

/** 摘要终态失败告警（abort 静默；其余逐态——观测不静默纪律） */
function warnOutcome(deps: CompactDeps, session: SessionId, outcome: Exclude<SummarizeOutcome, { ok: true }>): void {
  switch (outcome.reason) {
    case "failed":
      deps.warn(session, "summarize-failed");
      break;
    case "truncated":
      deps.warn(session, "summary-truncated");
      break;
    case "empty":
      deps.warn(session, "summarize-failed", { reason: "empty-summary" });
      break;
    case "budget-exhausted":
      deps.warn(session, "summary-input-budget-exhausted");
      break;
    default:
      break; // aborted 静默（操作者取消/看门狗跳过本轮）
  }
}

/** 落账入参 */
interface LandingCall {
  readonly deps: CompactDeps;
  readonly fields: CompactFields;
  readonly nodes: readonly SurfaceNode[];
  readonly start: number;
  readonly end: number;
  readonly summary: string;
  /** summaryTokens 计量段（不含注入段——非 LLM 输出，§15.1） */
  readonly tokensOf: string;
}

/** replace 位置区间落账 + 观测广播 */
function landSummary(call: LandingCall): CompactionResult {
  const { deps, fields, nodes, start, end, summary } = call;
  const session = deps.store.get(fields.session);
  if (session === undefined) return { ok: false, reason: "session-unknown" };
  const appended = session.append(
    "user/message",
    { turn: fields.turn, step: fields.step, content: [{ type: "text", text: summary }] },
    // 空区间不可达（无进展护栏 cut > 首候选 ≥ start ⇒ 端点恒在场），undefined 收窄仅为类型完备
    { surfaceOp: { op: "replace", startSeq: nodes[start]?.seq ?? -1, endSeq: nodes[end]?.seq ?? -1 } },
  );
  if (!appended.ok) return { ok: false, reason: "replace-failed" };
  const replacedNodes = end - start + 1;
  const summaryTokens = estimateText(call.tokensOf);
  deps.landed({ session: fields.session, trigger: fields.trigger, replacedNodes, summaryTokens });
  return { ok: true, replacedNodes, summaryTokens };
}

async function compactSession(
  deps: CompactDeps,
  fields: CompactFields,
  nodes: readonly SurfaceNode[],
): Promise<CompactionResult> {
  const quote = fields.trigger === "emergency" ? 0 : USER_QUOTE_TOKENS;
  const keep = fields.keepRecentTokens ?? deps.config.keepRecentTokens;
  const cut = findCutPoint(nodes, keep, quote);
  if (cut === undefined) return { ok: false, reason: "no-cut-point" };

  // 区间 = [保留头之后首节点 .. cut 前末节点]（system 锚点本身保留；位置区间语义）。
  // 空区间不可达：无进展护栏保证 cut > 首候选 ≥ start，故 end = cut − 1 ≥ start 恒成立
  const start = nodes[0] !== undefined && nodes[0].event.type === "system/message" ? 1 : 0;
  const end = cut.cut - 1;

  const face = deps.config.summarizer;
  if (face === undefined) {
    deps.warn(fields.session, "summarizer-unconfigured");
    return { ok: false, reason: "summarizer-unconfigured" };
  }
  const llm = deps.llm;
  if (llm === undefined) {
    deps.warn(fields.session, "summarize-failed", { reason: "llm-unavailable" });
    return { ok: false, reason: "llm-unavailable" };
  }

  // 注入段不进任何 LLM 输入/解析面：previousSummary 剥离后经 span 供 fileListsOf 与
  // summarizeSpan（三输入面之一——另两处：conversation 渲染与 parseFileOperations 输入）
  const rawPrevious = previousSummaryOf(nodes);
  const previousSummary = rawPrevious === undefined ? undefined : stripSummarySection(rawPrevious);
  const span: Span = { nodes: nodes.slice(start, cut.cut), previousSummary };
  const lists = fileListsOf(deps, fields.session, span);
  const outcome = await summarizeSpan({ deps, fields, span, face, llm });
  if (!outcome.ok) {
    warnOutcome(deps, fields.session, outcome);
    return { ok: false, reason: OUTCOME_REASONS[outcome.reason] };
  }

  // 组装序：正文 → 文件账本标签 → 续航注入语（manual 不附加）→ 注入段（恒为最末——§15.1）
  const tail = formatFileOperations(lists.readFiles, lists.modifiedFiles);
  const note = fields.trigger === "manual" ? "" : `\n\n${AUTO_CONTINUATION_NOTE}`;
  const body = `${outcome.text}${tail}${note}`;
  const section = renderSummarySection(deps, fields.session);
  return landSummary({ deps, fields, nodes, start, end, summary: section === undefined ? body : appendSummarySection(body, section), tokensOf: body });
}

/** 落账时点取卷渲染注入段；provider throw/缺席/会话已亡降级不注入（压缩主流程优先） */
function renderSummarySection(deps: CompactDeps, session: SessionId): string | undefined {
  const provider = deps.trySection();
  const log = deps.store.get(session);
  if (provider === undefined || log === undefined) return undefined;
  try {
    return provider.render(log.events());
  } catch (error) {
    deps.warn(session, "summary-section-failed", { reason: String(error) });
    return undefined;
  }
}
