// 清单内核（docs/TODO.md §13 修订B）：会话键控桶 + CRUD + 依赖单源边集 + deleted 清边 +
// 深拷贝 + 数值序 + 快照导出/惰性恢复。语义校验与最小形状防御单点住本层——工具面只铸文。
// 深层形状不防：类型即契约，宿主绕过 TypeScript 传垃圾 = 宿主 bug。
// 匿名桶（无 session 调用方共享单桶——`_anon` 非合法 SessionId，与真实会话 id 空间不相交）。

import type { SessionEvent, SessionId, TodoSnapshotEventData, TodoSnapshotTaskData } from "@x-harness/session";
import type {
  TodoCreateInput,
  TodoList,
  TodoReject,
  TodoStatus,
  TodoTask,
  TodoUpdatePatch,
} from "./tokens.ts";

interface TodoRow {
  readonly id: string;
  subject: string;
  status: TodoStatus;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

/** 会话桶闭包状态三件（快照导出/恢复的完整集合） */
interface Bucket {
  readonly rows: Map<string, TodoRow>;
  /** 依赖单源：blocker id → 它阻塞的 id 集合（blockedBy 由全表派生） */
  readonly blocksOf: Map<string, Set<string>>;
  seq: number;
}

const emptyBucket = (): Bucket => ({ rows: new Map(), blocksOf: new Map(), seq: 0 });

/** 数值序：id 是十进制递增字符串，字典序下 "10" < "2" 会乱序 */
function byNumericId(a: string, b: string): number {
  return Number(a) - Number(b);
}

function reject(reason: TodoReject["reason"], message: string): TodoReject {
  return { ok: false, reason, message };
}

/** 入库深拷贝：防 caller 引用变异穿透。不可克隆值（函数/symbol）拒——降级不崩溃 */
function cloneMetadata(value: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | TodoReject {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return reject("invalid-args", "metadata not cloneable");
  }
}

function checkTaskId(taskId: string): TodoReject | undefined {
  if (typeof taskId !== "string" || taskId === "") return reject("invalid-args", "taskId must be a non-empty string");
  if (taskId.includes("\n") || taskId.includes("\r")) return reject("invalid-args", "taskId must not contain newlines");
  return undefined;
}

/** 引用存在性校验：清单中不存在 → unknown；自引用（自阻塞即环）→ 拒；均点名 */
function checkReferences(input: { readonly rows: ReadonlyMap<string, TodoRow>; readonly taskId: string; readonly label: string; readonly ids: readonly string[] }): TodoReject | undefined {
  for (const id of input.ids) {
    if (!input.rows.has(id)) return reject("invalid-args", `${input.label} references unknown task '${id}'`);
    if (id === input.taskId) return reject("invalid-args", `${input.label} must not reference itself ('${id}')`);
  }
  return undefined;
}

function blockedByOf(bucket: Bucket, taskId: string): string[] {
  const out: string[] = [];
  for (const [blocker, blocked] of bucket.blocksOf) {
    if (blocked.has(taskId)) out.push(blocker);
  }
  return out.sort(byNumericId);
}

function rowSnapshot(row: TodoRow, bucket: Bucket): TodoTask {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    ...(row.description !== undefined ? { description: row.description } : {}),
    ...(row.activeForm !== undefined ? { activeForm: row.activeForm } : {}),
    ...(row.owner !== undefined ? { owner: row.owner } : {}),
    ...(row.metadata !== undefined ? { metadata: structuredClone(row.metadata) } : {}),
    blocks: [...(bucket.blocksOf.get(row.id) ?? [])].sort(byNumericId),
    blockedBy: blockedByOf(bucket, row.id),
  };
}

/** 删除并清边：正向（它阻塞的）整桶删 + 反向（阻塞它的）逐条摘——防悬空 id 渲染 */
function removeRow(bucket: Bucket, row: TodoRow): void {
  bucket.blocksOf.delete(row.id);
  for (const blocked of bucket.blocksOf.values()) blocked.delete(row.id);
  bucket.rows.delete(row.id);
}

function bucketCreate(bucket: Bucket, input: TodoCreateInput): TodoTask | TodoReject {
  if (typeof input.subject !== "string" || input.subject === "") {
    return reject("invalid-args", "subject must be a non-empty string");
  }
  let metadata: Record<string, unknown> | undefined;
  if (input.metadata !== undefined) {
    const cloned = cloneMetadata(input.metadata);
    if (!cloned.ok) return cloned;
    metadata = cloned.value;
  }
  bucket.seq += 1;
  const row: TodoRow = {
    id: String(bucket.seq),
    subject: input.subject,
    status: "pending",
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
  bucket.rows.set(row.id, row);
  return rowSnapshot(row, bucket);
}

function bucketGet(bucket: Bucket, taskId: string): TodoTask | TodoReject {
  const row = bucket.rows.get(taskId);
  if (row === undefined) return reject("not-found", `${taskId}; no such task`);
  return rowSnapshot(row, bucket);
}

function bucketList(bucket: Bucket): readonly TodoTask[] {
  return [...bucket.rows.values()].map((row) => rowSnapshot(row, bucket)).sort((a, b) => byNumericId(a.id, b.id));
}

/** 更新解析段：subject 语义 + metadata 键级合并（不碰行数据——校验全过才应用） */
function resolveUpdate(row: TodoRow, patch: TodoUpdatePatch): { ok: true; metadata?: Record<string, unknown>; metadataTouched: boolean } | TodoReject {
  if (patch.subject === "") return reject("invalid-args", "subject must be a non-empty string");
  let metadata: Record<string, unknown> | undefined;
  let metadataTouched = false;
  if (patch.metadata !== undefined) {
    const merged = mergeMetadata(row.metadata, patch.metadata);
    if (!merged.ok) return merged;
    metadata = merged.value;
    metadataTouched = true;
  }
  return { ok: true, ...(metadata !== undefined ? { metadata } : {}), metadataTouched };
}

/** 更新赋值段（status 的 deleted 分支已在调用点 early-return——此处只会见到 TodoStatus） */
function applyUpdateFields(row: TodoRow, patch: TodoUpdatePatch, resolved: { metadata?: Record<string, unknown>; metadataTouched: boolean }): void {
  if (patch.subject !== undefined) row.subject = patch.subject;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.activeForm !== undefined) row.activeForm = patch.activeForm;
  if (patch.status !== undefined) row.status = patch.status as TodoStatus;
  if (patch.owner !== undefined) row.owner = patch.owner;
  // 合并删光是合法终态（undefined）——须与「未传 metadata」区分，否则旧值残留
  if (resolved.metadataTouched) {
    if (resolved.metadata !== undefined) row.metadata = resolved.metadata;
    else delete row.metadata;
  }
}

/** 更新落边段：addBlocks/addBlockedBy 追加去重（调用前引用校验已全过） */
function applyUpdateEdges(bucket: Bucket, row: TodoRow, patch: TodoUpdatePatch): void {
  if (patch.addBlocks !== undefined) {
    const blocked = bucket.blocksOf.get(row.id) ?? new Set<string>();
    for (const id of patch.addBlocks) blocked.add(id);
    bucket.blocksOf.set(row.id, blocked);
  }
  if (patch.addBlockedBy !== undefined) {
    for (const blocker of patch.addBlockedBy) {
      const blocked = bucket.blocksOf.get(blocker) ?? new Set<string>();
      blocked.add(row.id);
      bucket.blocksOf.set(blocker, blocked);
    }
  }
}

function bucketUpdate(bucket: Bucket, taskId: string, patch: TodoUpdatePatch): TodoTask | { ok: true; deleted: true } | TodoReject {
  const bad = checkTaskId(taskId);
  if (bad !== undefined) return bad;
  const row = bucket.rows.get(taskId);
  if (row === undefined) return reject("not-found", `${taskId}; no such task`);
  // 删除优先：status=deleted 与其余字段同传时余字段静默忽略（无「先改后删」中间态）
  if (patch.status === "deleted") {
    removeRow(bucket, row);
    return { ok: true, deleted: true };
  }
  // 先验全部字段与依赖引用再应用（部分应用后遇未知 id 回滚是中间态——一次校验原子应用）
  const resolved = resolveUpdate(row, patch);
  if (!resolved.ok) return resolved;
  if (patch.addBlocks !== undefined) {
    const badBlocks = checkReferences({ rows: bucket.rows, taskId, label: "addBlocks", ids: patch.addBlocks });
    if (badBlocks !== undefined) return badBlocks;
  }
  if (patch.addBlockedBy !== undefined) {
    const badBlockedBy = checkReferences({ rows: bucket.rows, taskId, label: "addBlockedBy", ids: patch.addBlockedBy });
    if (badBlockedBy !== undefined) return badBlockedBy;
  }
  applyUpdateFields(row, patch, resolved);
  applyUpdateEdges(bucket, row, patch);
  return rowSnapshot(row, bucket);
}

/** 桶闭包状态导出（append 铸事件用；metadata 深拷贝隔离卷内冻结对象） */
function snapshotOfBucket(bucket: Bucket): TodoSnapshotEventData {
  const tasks: TodoSnapshotTaskData[] = [...bucket.rows.values()]
    .sort((a, b) => byNumericId(a.id, b.id))
    .map((row) => ({
      id: row.id,
      subject: row.subject,
      status: row.status,
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.activeForm !== undefined ? { activeForm: row.activeForm } : {}),
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
      ...(row.metadata !== undefined ? { metadata: structuredClone(row.metadata) } : {}),
    }));
  const edges: Array<readonly [string, string]> = [];
  for (const [blocker, blocked] of [...bucket.blocksOf.entries()].sort((a, b) => byNumericId(a[0], b[0]))) {
    for (const id of [...blocked].sort(byNumericId)) edges.push([blocker, id]);
  }
  return { seq: bucket.seq, tasks, edges };
}

/** 恢复：事件卷 data 是 deepFreeze 产物——深拷贝重建可变副本（恢复后 update 变异不 throw） */
function restoreBucket(bucket: Bucket, data: TodoSnapshotEventData): void {
  const source = structuredClone(data);
  bucket.seq = source.seq;
  bucket.rows.clear();
  bucket.blocksOf.clear();
  for (const task of source.tasks) {
    bucket.rows.set(task.id, {
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
      ...(task.owner !== undefined ? { owner: task.owner } : {}),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    });
  }
  for (const [blocker, blocked] of source.edges) {
    const set = bucket.blocksOf.get(blocker) ?? new Set<string>();
    set.add(blocked);
    bucket.blocksOf.set(blocker, set);
  }
}

/** 事件卷折尾取最后一条 todo/snapshot（last-wins）；无词条 → undefined（全新桶） */
export function latestTodoSnapshot(events: readonly SessionEvent[]): TodoSnapshotEventData | undefined {
  let last: TodoSnapshotEventData | undefined;
  for (const event of events) {
    if (event.type === "todo/snapshot") last = event.data;
  }
  return last;
}

export function createTodoStore(): TodoList {
  const buckets = new Map<string, Bucket>();
  const keyOf = (session: SessionId | undefined): string => session ?? "_anon";
  const bucketFor = (session: SessionId | undefined): Bucket => {
    const key = keyOf(session);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      buckets.set(key, bucket);
    }
    return bucket;
  };

  return {
    create: (session, input) => {
      const result = bucketCreate(bucketFor(session), input);
      return "ok" in result ? result : { ok: true, task: result };
    },
    get: (session, taskId) => {
      const bad = checkTaskId(taskId);
      if (bad !== undefined) return bad;
      const result = bucketGet(bucketFor(session), taskId);
      return "ok" in result ? result : { ok: true, task: result };
    },
    list: (session) => bucketList(bucketFor(session)),
    update: (session, taskId, patch) => {
      const result = bucketUpdate(bucketFor(session), taskId, patch);
      return "ok" in result ? result : { ok: true, task: result };
    },
    snapshotOf: (session) => snapshotOfBucket(bucketFor(session)),
    restore: (session, events) => {
      const key = keyOf(session);
      // 桶在场即跳过：不覆盖内存变更（含 append 失败期间保留的桶内状态）
      if (buckets.has(key)) return;
      const last = latestTodoSnapshot(events);
      if (last !== undefined) restoreBucket(bucketFor(session), last);
    },
    evict: (session) => {
      buckets.delete(session as string);
    },
  };
}

/** 键级合并（规格语义）：同名键覆盖；值为 null 删除该键 */
function mergeMetadata(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> | undefined } | TodoReject {
  const cloned = cloneMetadata(incoming);
  if (!cloned.ok) return cloned;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(cloned.value)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return { ok: true, value: Object.keys(next).length > 0 ? next : undefined };
}
