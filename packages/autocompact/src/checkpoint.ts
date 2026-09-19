// 检查点总结（docs/COMPACTION.md §1.2；参照系 checkpoint 移植）：后台异步维护滚动
// 账本——唯一常规 LLM 总结面。纪律：单飞行；由步闸启动并链当步 turn signal；
// 输入硬界（CP 面自身窗宽为分母、CJK 安全折算、预算 <1 不拨号）；失效判定 =
// 作业期前缀替换落账（compaction 摘要/L2 账本——L1 单点 tool/result 替换不参与，
// patch 描述的原文正是账本想要的）；三分支终态：段被吞 → 重锚丢弃（非失败）、
// 失效且重试有余 → 重锚重拨、重试耗尽 → stale 接受（免疫终态）；连续 3 败熔断还接管。
// patch 与切口经 autocompact/checkpoint 词条落盘（恢复期 fold 重建；L2 摘要文本
// 不作恢复源——呈现≠数据）。提示词面英文（模型可见文本纪律）。

import type { LlmRuntime } from "@x-harness/llm";
import type { Session, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import {
  accumulateFileOps,
  capSerializedConversation,
  computeFileLists,
  DEFAULT_FILE_TOOLS,
  formatFileOperations,
  isTurnStartNode,
  neutralizeLineStarts,
  nodeTokens,
  runTextRequest,
  serializeConversation,
  type FileToolNames,
  type SummarizerFace,
} from "@x-harness/compaction";
import { WIDE_TOKENS_PER_CHAR } from "@x-harness/token-meter";
import { emptyLedger, mergeLedger, parseLedgerPatch, serializeLedger, serializeLedgerForPrompt, trimLedger, ledgerReady, type Ledger } from "./ledger.ts";
import { SUMMARIZER_RESERVE_CAP } from "./lines.ts";
import { lastTurnStartIndex } from "./scavenger.ts";
import type { CheckpointAction } from "./tokens.ts";

export const CP_SYSTEM_PROMPT =
  "You are a context ledger maintenance assistant. You update a structured working ledger for an ongoing engineering session. Output ONLY the updated ledger sections in the exact tag format requested. Do NOT continue the conversation. Do NOT answer any questions in the conversation.";

export const CP_UPDATE_PROMPT = `The <ledger> above is the current working ledger. The <new-segment> contains the latest conversation messages not yet incorporated into it.

Update the ledger with the new segment. RULES:
- goals: user intents and objectives; append or refine, never drop an existing goal line
- decisions: settled design decisions; append-only; to overturn an earlier decision, add a new line that says which earlier line it supersedes
- done: completed tasks; a pending line that is now complete moves here verbatim
- pending: open tasks; remove lines that moved to done
- verified: facts confirmed by evidence in the conversation
- unverified: assumptions not yet confirmed; move a line to verified once evidence appears
- current: the work in progress right now and the immediate next step (rewritten each time)

Output ALL seven sections with these exact tags:
<goals>...</goals>
<decisions>...</decisions>
<done>...</done>
<pending>...</pending>
<verified>...</verified>
<unverified>...</unverified>
<current>...</current>

Keep each line concise. Preserve exact file paths, function names, and error messages.`;

export interface CheckpointConfig {
  readonly ledgerBudgetTokens: number;
  readonly checkpointMaxRetries: number;
  readonly checkpointIdleTimeoutMs: number;
}

export interface CheckpointJob {
  /** 作业启动时的日志长度：此后落账的前缀替换（user/message replace）即失效令牌 */
  readonly startSeq: number;
  /** 段锚：作业启动时段首节点的 seq（失效判定面——缺席即段被吞） */
  readonly segmentFromSeq: number;
  /** 段起点节点下标（失效重锚后收缩） */
  segmentFrom: number;
  retries: number;
  readonly turn: number;
  readonly step: number;
  readonly controller: AbortController;
  done: Promise<void>;
  /** 出参：装箱段尾节点下标（切口推进边界） */
  boxedEnd: number | undefined;
}

export interface CheckpointState {
  ledger: Ledger;
  /** 账本已收编覆盖的 journal seq 边界（-1 = 未覆盖任何节点）；位置上界后为未收编区 */
  coveredSeq: number;
  armed: boolean;
  consecutiveFailures: number;
  broken: boolean;
  job: CheckpointJob | undefined;
}

export function emptyCheckpointState(): CheckpointState {
  return { ledger: emptyLedger(), coveredSeq: -1, armed: true, consecutiveFailures: 0, broken: false, job: undefined };
}

export interface CheckpointDeps {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly session: Session;
  readonly config: CheckpointConfig;
  readonly fileTools: FileToolNames;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly emit: (action: CheckpointAction, detail?: Record<string, unknown>) => void;
  /** 熔断回调：还接管（runner.setAutoTriggerEnabled(true) 交还 compaction 水位） */
  readonly onBreaker: () => void;
}

/** CP 输入硬界：(CP 窗 − min(输出上限, 20k) − 4k − 账本字符) / 上界费率；
 *  < 1 → undefined：拨号根本不发起，不白付一次必败请求 */
export function checkpointMaxChars(face: SummarizerFace, ledgerChars: number): number | undefined {
  const budget = face.contextWindow - Math.min(face.maxOutputTokens, 20_000) - 4_000 - ledgerChars;
  return budget >= 1 ? Math.floor(budget / WIDE_TOKENS_PER_CHAR) : undefined;
}

/** 段装箱（冷启分段收编 + 在飞轮整轮不入账）：自尾向首按 token 预算取
 *  [start, end)——end 对齐在飞轮起点（lastTurnStart），start 对齐真轮起点；
 *  预算耗尽即停（下一段收编剩余——早期内容不因单次截头而永久丢失）。
 *  返回 undefined = 无可装箱段。 */
export function boxSegment(fields: {
  readonly nodes: readonly SurfaceNode[];
  readonly from: number;
  readonly lastTurnStart: number;
  readonly tokenBudget: number;
}): { readonly start: number; readonly end: number } | undefined {
  const { nodes, tokenBudget } = fields;
  const end = Math.min(fields.lastTurnStart, nodes.length); // 尾界=在飞轮起点，不越
  if (end <= fields.from) return undefined; // from 起无完整轮
  let acc = 0;
  let start = end;
  for (let i = end - 1; i >= fields.from; i -= 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const tokens = nodeTokens(node);
    if (acc + tokens > tokenBudget && start < end) break; // 至少装一轮
    acc += tokens;
    if (isTurnStartNode(node)) start = i; // 起点对齐真轮起点（配对安全构造保证）
  }
  if (start >= end) return undefined;
  return { start, end };
}

/** 段内机械 files 文本（事件提取，零 LLM——账本 files 节的组装面） */
export function filesTextOf(segment: readonly SurfaceNode[]): string {
  const ops = accumulateFileOps(segment, { readFiles: [], modifiedFiles: [] }, DEFAULT_FILE_TOOLS);
  const lists = computeFileLists(ops);
  return formatFileOperations(lists.readFiles, lists.modifiedFiles).trim();
}

/** maybeStartCheckpoint：上升沿再武装与段门槛由步闸维护，此处只做单飞行与启动 */
export function maybeStartCheckpoint(fields: {
  readonly state: CheckpointState;
  readonly deps: CheckpointDeps;
  readonly stepSignal: AbortSignal;
  readonly lastTurnStart: number;
  readonly turn: number;
  readonly step: number;
}): boolean {
  const { state, deps } = fields;
  if (state.broken || state.job !== undefined) return false;
  const nodes = deps.session.surface();
  const from = firstUncoveredIndex(state, nodes);
  if (fields.lastTurnStart <= from) return false; // 段内无完整轮（在飞轮不入账）
  const controller = new AbortController();
  // step 信号是 turn 级长寿命——监听器完成后显式移除（不随会话累积）
  const onStepAbort = (): void => controller.abort();
  if (fields.stepSignal.aborted) controller.abort();
  else fields.stepSignal.addEventListener("abort", onStepAbort, { once: true });
  const fromSeq = nodes[from - 1] !== undefined ? (nodes[from - 1] as SurfaceNode).seq : -1;
  const job: CheckpointJob = {
    startSeq: deps.session.events().length,
    segmentFromSeq: fromSeq,
    segmentFrom: from,
    retries: 0,
    turn: fields.turn,
    step: fields.step,
    controller,
    done: Promise.resolve(),
    boxedEnd: undefined,
  };
  state.job = job;
  job.done = runCheckpoint({ state, job, deps }).finally(() => {
    if (state.job === job) state.job = undefined;
    fields.stepSignal.removeEventListener("abort", onStepAbort);
  });
  deps.emit("started", { segmentFrom: job.segmentFrom });
  return true;
}

/** L2 落账/紧急压缩吞段时取消在飞作业（重算是无输入的幻影调用） */
export function cancelJob(state: CheckpointState): void {
  const job = state.job;
  if (job === undefined) return;
  state.job = undefined;
  job.controller.abort();
}

/** join 在飞作业（放行预算的过闸前优化）：看门狗超时/取消后返回就绪现状。
 *  计时器全路径清理（作业先落定同样 clearTimeout——缺省会留 120s 引用计时器
 *  拖住事件循环并随 join 次数累积）；预中止信号直接就绪态返回（不再等待） */
export async function joinInflight(fields: { readonly state: CheckpointState; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<boolean> {
  const job = fields.state.job;
  if (job === undefined) return ledgerReady(fields.state.ledger) && !fields.state.broken;
  if (fields.signal?.aborted) return ledgerReady(fields.state.ledger) && !fields.state.broken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, fields.timeoutMs);
    onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    fields.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([job.done, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) fields.signal?.removeEventListener("abort", onAbort);
  }
  return ledgerReady(fields.state.ledger) && !fields.state.broken;
}

/** 覆盖边界的节点下标（位置语义：coveredSeq 定位边界节点、其后为首未覆盖节点）。
 *  迭代前缀替换后头部节点携带 journal 尾 seq、其后保留节点 seq 更小——数值比较
 *  扫描会把整个保留区误判为未覆盖（或相反），必须以 seq 定位边界节点的**位置**；
 *  边界节点已不在投影（被外部替换吞掉）时回退数值扫描（恢复期保守形态） */
export function firstUncoveredIndex(state: CheckpointState, nodes: readonly SurfaceNode[]): number {
  for (const [i, node] of nodes.entries()) {
    if (node.seq === state.coveredSeq) return i + 1;
  }
  for (const [i, node] of nodes.entries()) {
    if (node.seq > state.coveredSeq) return i;
  }
  return nodes.length;
}

/** 新投影的保守覆盖边界（外部落账/吞段后的重锚面）：首个切口候选（锚点之后的
 *  真轮起点——anchorIndexOf 共用谓词，预锚注入不计候选）之前节点的 seq——该前缀
 *  已被外部摘要承载，视为已覆盖；无候选 → 末节点 seq（全投影视为覆盖前缀的外部
 *  承载面）；无锚 → 维持跳过首节点的旧口径 */
export function conservativeBoundarySeq(nodes: readonly SurfaceNode[]): number {
  const anchor = anchorIndexOf(nodes);
  const from = anchor < 0 ? 1 : anchor + 1;
  for (let i = from; i < nodes.length; i += 1) {
    if (isTurnStartNode(nodes[i] as SurfaceNode)) return (nodes[i - 1] as SurfaceNode).seq;
  }
  return nodes.length > 0 ? (nodes[nodes.length - 1] as SurfaceNode).seq : -1;
}

async function runCheckpoint(fields: { readonly state: CheckpointState; readonly job: CheckpointJob; readonly deps: CheckpointDeps }): Promise<void> {
  const { state, job, deps } = fields;
  try {
    for (;;) {
      const patch = await callCheckpointModel({ state, job, deps });
      if (patch === undefined) return; // 失败/取消已按其语义处置
      const nodes = deps.session.surface();
      // 失效判定：作业启动后落账的前缀替换（compaction 摘要 / L2 账本）。
      // 三分支：段被吞 → 重锚丢弃非失败；重试有余 → 重锚重拨；耗尽 → stale 接受
      if (jobInvalidated(deps.session.events(), job)) {
        job.segmentFrom = Math.min(job.segmentFrom, nodes.length);
        // 段锚（作业启动时的段首节点 seq）不在投影 = 段被外部落账吞掉：
        // 保守降级重锚（min——未收编段重新从外部摘要边界起算，L2 覆盖域守卫恢复有效）
        const anchorGone = job.segmentFromSeq >= 0 && nodes.every((node) => node.seq !== job.segmentFromSeq);
        if (nodes.length <= job.segmentFrom || anchorGone) {
          state.coveredSeq = Math.min(state.coveredSeq, conservativeBoundarySeq(nodes));
          deps.emit("reanchored", { segmentFrom: job.segmentFrom });
          return;
        }
        if (job.retries >= deps.config.checkpointMaxRetries) {
          acceptPatch({ state, job, deps, patch, stale: true });
          return;
        }
        // 段锚在场：按 seq 重新定位段首（外部部分替换使下标漂移——数值定位不漂移）
        const anchorIndex = nodes.findIndex((node) => node.seq === job.segmentFromSeq);
        if (anchorIndex >= 0) job.segmentFrom = anchorIndex;
        job.retries += 1;
        deps.emit("invalidated-retry", { retries: job.retries });
        continue;
      }
      acceptPatch({ state, job, deps, patch, stale: false });
      return;
    }
  } catch (error) {
    if (job.controller.signal.aborted) return;
    deps.warn(deps.session.id, "checkpoint-failed", { error: error instanceof Error ? error.message : String(error) });
    failOnce(state, deps);
  }
}

/** 作业失效判定：启动后存在前缀替换落账（replace 型 user/message——L1 的
 *  tool/result 单点替换不参与：patch 描述的原文正是账本想要的） */
function jobInvalidated(events: readonly SessionEvent[], job: CheckpointJob): boolean {
  for (let i = job.startSeq; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") return true;
  }
  return false;
}

/** 单次 CP 拨号：提示词（账本稳定前缀 + 新段变化尾，双轨中和）→ 终态 → patch
 *  解析。undefined = 失败或取消（已按语义处置） */
async function callCheckpointModel(fields: {
  readonly state: CheckpointState;
  readonly job: CheckpointJob;
  readonly deps: CheckpointDeps;
}): Promise<Ledger | undefined> {
  const { state, job, deps } = fields;
  const nodes = deps.session.surface();
  job.boxedEnd = undefined;
  const ledgerText = serializeLedger(state.ledger);
  const maxChars = checkpointMaxChars(deps.face, ledgerText.length);
  if (maxChars === undefined) {
    deps.warn(deps.session.id, "checkpoint-failed", { reason: "cp-input-budget-exhausted" });
    deps.emit("failed", { reason: "cp-input-budget-exhausted" });
    failOnce(state, deps);
    return undefined;
  }
  // 段装箱：token 预算由 chars 硬界折算（西文等价保守值；装箱后 serialize 仍受
  // cap 硬界兜底）
  const lastStart = lastTurnStartIndex(nodes);
  const boxed = boxSegment({
    nodes,
    from: job.segmentFrom,
    // 无真轮起点的退化投影按全投影收编（参照系容错——不烧熔断预算）
    lastTurnStart: lastStart < 0 ? nodes.length : lastStart,
    tokenBudget: Math.max(1, Math.floor(maxChars / 4)),
  });
  if (boxed === undefined) {
    failOnce(state, deps); // 无净轮可装（收尾段 tool_result 形等）
    return undefined;
  }
  const segment = nodes.slice(boxed.start, boxed.end);
  // 截头可切掉中和的前导空格——cap 后重跑行首破坏封复活面
  const segmentText = neutralizeLineStarts(capSerializedConversation(serializeConversation(segment), maxChars));
  job.boxedEnd = boxed.end;
  // 账本行含模型输出与工具内容（"Preserve exact" 鼓励逐字回显）——嵌入面过双轨
  // 中和：节壳字面半角（exact tags 要求），内容行封毒
  const prompt = `<ledger>\n${serializeLedgerForPrompt(state.ledger)}\n</ledger>\n\n<new-segment>\n${segmentText}\n</new-segment>\n\n${CP_UPDATE_PROMPT}`;
  const outcome = await runTextRequest({
    llm: deps.llm,
    // 输出上限与输入预留同口径封顶（>20k 面会超 CP 自身窗——预留按 20k 算而输出放行是错配）
    face: { ...deps.face, maxOutputTokens: Math.min(deps.face.maxOutputTokens, SUMMARIZER_RESERVE_CAP) },
    system: CP_SYSTEM_PROMPT,
    prompt,
    idleTimeoutMs: deps.config.checkpointIdleTimeoutMs,
    signal: job.controller.signal,
  });
  if (job.controller.signal.aborted) return undefined; // 取消（L2 吞段/会话关闭）：非失败
  if (!outcome.ok) {
    if (outcome.reason === "failed") deps.warn(deps.session.id, "checkpoint-failed", { reason: "provider-error" });
    else if (outcome.reason === "truncated") deps.warn(deps.session.id, "checkpoint-failed", { reason: "ledger-output-truncated" });
    failOnce(state, deps);
    return undefined;
  }
  const patch = parseLedgerPatch(outcome.text);
  if (patch === undefined) {
    deps.warn(deps.session.id, "checkpoint-failed", { reason: "ledger-patch-unparsable" });
    failOnce(state, deps);
  }
  return patch;
}

function acceptPatch(fields: {
  readonly state: CheckpointState;
  readonly job: CheckpointJob;
  readonly deps: CheckpointDeps;
  readonly patch: Ledger;
  readonly stale: boolean;
}): void {
  const { state, job, deps, patch, stale } = fields;
  state.ledger = trimLedger(mergeLedger(state.ledger, patch), deps.config.ledgerBudgetTokens);
  // 切口推进到装箱段尾前末节点（boxedEnd 缺席 = 退化路径 → 推进到当前投影尾）；
  // 单调不回退
  const nodes = deps.session.surface();
  const boundaryNode = job.boxedEnd !== undefined ? nodes[job.boxedEnd - 1] : nodes[nodes.length - 1];
  const newCovered = boundaryNode !== undefined ? boundaryNode.seq : state.coveredSeq;
  state.coveredSeq = Math.max(state.coveredSeq, newCovered);
  state.consecutiveFailures = 0;
  // 持久化：账本快照 + 覆盖边界（恢复期 fold）。落账失败按检查点失败处置——
  // 静默丢失会让崩溃恢复回退旧账本
  const recorded = deps.session.append("autocompact/checkpoint", {
    turn: job.turn,
    step: job.step,
    ledger: serializeLedger(state.ledger),
    coveredSeq: state.coveredSeq,
    ...(stale ? { stale: true } : {}),
  });
  if (!recorded.ok) throw new Error(`checkpoint append failed: ${recorded.reason}`);
  deps.emit(stale ? "stale-accepted" : "advanced", { coveredSeq: state.coveredSeq });
}

function failOnce(state: CheckpointState, deps: CheckpointDeps): void {
  state.consecutiveFailures += 1;
  deps.emit("failed", { failures: state.consecutiveFailures });
  if (state.consecutiveFailures < 3) return;
  state.broken = true;
  deps.emit("breaker", { failures: state.consecutiveFailures });
  deps.onBreaker();
}

/** 恢复 fold：重放 autocompact/checkpoint 词条（快照式，最后有效者胜）重建账本
 *  与覆盖边界；垃圾快照跳过 */
export function foldCheckpointEvents(events: readonly SessionEvent[]): { readonly ledger: Ledger; readonly coveredSeq: number } {
  const result = { ledger: emptyLedger(), coveredSeq: -1 };
  for (const event of events) {
    if (event.type !== "autocompact/checkpoint") continue;
    const data = event.data as { ledger?: unknown; coveredSeq?: unknown };
    if (typeof data.ledger !== "string" || typeof data.coveredSeq !== "number" || !Number.isFinite(data.coveredSeq)) continue;
    const ledger = parseLedgerPatch(data.ledger);
    if (ledger === undefined) continue;
    result.ledger = ledger;
    result.coveredSeq = Math.max(-1, Math.floor(data.coveredSeq));
  }
  return result;
}
