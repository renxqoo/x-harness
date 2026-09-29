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

interface Bucket {
  readonly rows: Map<string, TodoRow>;
  readonly blocksOf: Map<string, Set<string>>;
  seq: number;
}

const emptyBucket = (): Bucket => ({ rows: new Map(), blocksOf: new Map(), seq: 0 });

function byNumericId(a: string, b: string): number {
  return Number(a) - Number(b);
}

function reject(reason: TodoReject["reason"], message: string): TodoReject {
  return { ok: false, reason, message };
}

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

function applyUpdateFields(row: TodoRow, patch: TodoUpdatePatch, resolved: { metadata?: Record<string, unknown>; metadataTouched: boolean }): void {
  if (patch.subject !== undefined) row.subject = patch.subject;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.activeForm !== undefined) row.activeForm = patch.activeForm;
  if (patch.status !== undefined) row.status = patch.status as TodoStatus;
  if (patch.owner !== undefined) row.owner = patch.owner;
  if (resolved.metadataTouched) {
    if (resolved.metadata !== undefined) row.metadata = resolved.metadata;
    else delete row.metadata;
  }
}

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
  const row = bucket.rows.get(taskId);
  if (row === undefined) return reject("not-found", `${taskId}; no such task`);
  if (patch.status === "deleted") {
    removeRow(bucket, row);
    return { ok: true, deleted: true };
  }
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
  const peekBucket = (session: SessionId | undefined): Bucket | undefined => buckets.get(keyOf(session));
  const ensureBucket = (session: SessionId | undefined): Bucket => {
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
      const result = bucketCreate(ensureBucket(session), input);
      return "ok" in result ? result : { ok: true, task: result };
    },
    get: (session, taskId) => {
      const bad = checkTaskId(taskId);
      if (bad !== undefined) return bad;
      const bucket = peekBucket(session);
      if (bucket === undefined) return reject("not-found", `${taskId}; no such task`);
      const result = bucketGet(bucket, taskId);
      return "ok" in result ? result : { ok: true, task: result };
    },
    list: (session) => {
      const bucket = peekBucket(session);
      return bucket === undefined ? [] : bucketList(bucket);
    },
    update: (session, taskId, patch) => {
      const bad = checkTaskId(taskId);
      if (bad !== undefined) return bad;
      const bucket = peekBucket(session);
      if (bucket === undefined) return reject("not-found", `${taskId}; no such task`);
      const result = bucketUpdate(bucket, taskId, patch);
      return "ok" in result ? result : { ok: true, task: result };
    },
    snapshotOf: (session) => {
      const bucket = peekBucket(session);
      return bucket === undefined ? { seq: 0, tasks: [], edges: [] } : snapshotOfBucket(bucket);
    },
    restore: (session, eventsOf) => {
      if (peekBucket(session) !== undefined) return;
      const last = latestTodoSnapshot(eventsOf());
      if (last !== undefined) restoreBucket(ensureBucket(session), last);
    },
    evict: (session) => {
      buckets.delete(session as string);
    },
  };
}

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
