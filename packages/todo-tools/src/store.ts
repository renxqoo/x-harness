// 清单内核（docs/TODO.md §1.2/§1.4）：CRUD + 依赖单源边集 + deleted 清边 + 深拷贝 + 数值序。
// 语义校验单点住本层（空 subject / taskId 形状 / 依赖引用存在性）——工具面只铸文；
// 形状守卫（typeof）不在此层：类型即契约，宿主绕过 TypeScript 传垃圾 = 宿主 bug。

import type {
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

export function createTodoStore(): TodoList {
  const rows = new Map<string, TodoRow>();
  /** 依赖单源：blocker id → 它阻塞的 id 集合（A blocks B 的一条边只在此处落一次；
   *  blockedBy 由全表派生——协作清单量级下 O(n) 派生成本可忽略） */
  const blocksOf = new Map<string, Set<string>>();
  let seq = 0;

  const blockedByOf = (taskId: string): string[] => {
    const out: string[] = [];
    for (const [blocker, blocked] of blocksOf) {
      if (blocked.has(taskId)) out.push(blocker);
    }
    return out.sort(byNumericId);
  };

  const snapshot = (row: TodoRow): TodoTask => {
    const blocks = [...(blocksOf.get(row.id) ?? [])].sort(byNumericId);
    return {
      id: row.id,
      subject: row.subject,
      status: row.status,
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.activeForm !== undefined ? { activeForm: row.activeForm } : {}),
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
      ...(row.metadata !== undefined ? { metadata: structuredClone(row.metadata) } : {}),
      blocks,
      blockedBy: blockedByOf(row.id),
    };
  };

  /** 删除并清边：正向（它阻塞的）整桶删 + 反向（阻塞它的）逐条摘——防悬空 id 渲染 */
  const removeRow = (row: TodoRow): void => {
    blocksOf.delete(row.id);
    for (const blocked of blocksOf.values()) blocked.delete(row.id);
    rows.delete(row.id);
  };

  /** 引用存在性校验：清单中不存在 → unknown；自引用（自阻塞即环）→ 拒；均点名 */
  const checkReferences = (taskId: string, label: string, ids: readonly string[]): TodoReject | undefined => {
    for (const id of ids) {
      if (!rows.has(id)) return reject("invalid-args", `${label} references unknown task '${id}'`);
      if (id === taskId) return reject("invalid-args", `${label} must not reference itself ('${id}')`);
    }
    return undefined;
  };

  return {
    create: (input) => {
      if (typeof input.subject !== "string" || input.subject === "") {
        return reject("invalid-args", "subject must be a non-empty string");
      }
      let metadata: Record<string, unknown> | undefined;
      if (input.metadata !== undefined) {
        const cloned = cloneMetadata(input.metadata);
        if (!cloned.ok) return cloned;
        metadata = cloned.value;
      }
      seq += 1;
      const row: TodoRow = {
        id: String(seq),
        subject: input.subject,
        status: "pending",
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      };
      rows.set(row.id, row);
      return { ok: true, task: snapshot(row) };
    },

    get: (taskId) => {
      const bad = checkTaskId(taskId);
      if (bad !== undefined) return bad;
      const row = rows.get(taskId);
      if (row === undefined) return reject("not-found", `${taskId}; no such task`);
      return { ok: true, task: snapshot(row) };
    },

    list: () => [...rows.values()].map(snapshot).sort((a, b) => byNumericId(a.id, b.id)),

    update: (taskId, patch) => {
      const bad = checkTaskId(taskId);
      if (bad !== undefined) return bad;
      const row = rows.get(taskId);
      if (row === undefined) return reject("not-found", `${taskId}; no such task`);
      // 删除优先：status=deleted 与其余字段同传时余字段静默忽略（无「先改后删」中间态）
      if (patch.status === "deleted") {
        removeRow(row);
        return { ok: true, deleted: true };
      }
      // 先验全部字段与依赖引用再应用（部分应用后遇未知 id 回滚是中间态——一次校验原子应用）
      const resolved = resolveUpdate(row, patch);
      if (!resolved.ok) return resolved;
      if (patch.addBlocks !== undefined) {
        const badBlocks = checkReferences(taskId, "addBlocks", patch.addBlocks);
        if (badBlocks !== undefined) return badBlocks;
      }
      if (patch.addBlockedBy !== undefined) {
        const badBlockedBy = checkReferences(taskId, "addBlockedBy", patch.addBlockedBy);
        if (badBlockedBy !== undefined) return badBlockedBy;
      }
      applyUpdateFields(row, patch, resolved);
      applyUpdateEdges(blocksOf, row, patch);
      return { ok: true, task: snapshot(row) };
    },
  };
}

/** 更新解析段：subject 语义 + metadata 键级合并（不碰行数据——校验全过才应用） */
function resolveUpdate(
  row: TodoRow,
  patch: TodoUpdatePatch,
): { ok: true; metadata?: Record<string, unknown>; metadataTouched: boolean } | TodoReject {
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
function applyUpdateFields(
  row: TodoRow,
  patch: TodoUpdatePatch,
  resolved: { metadata?: Record<string, unknown>; metadataTouched: boolean },
): void {
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
function applyUpdateEdges(blocksOf: Map<string, Set<string>>, row: TodoRow, patch: TodoUpdatePatch): void {
  if (patch.addBlocks !== undefined) {
    const blocked = blocksOf.get(row.id) ?? new Set<string>();
    for (const id of patch.addBlocks) blocked.add(id);
    blocksOf.set(row.id, blocked);
  }
  if (patch.addBlockedBy !== undefined) {
    for (const blocker of patch.addBlockedBy) {
      const blocked = blocksOf.get(blocker) ?? new Set<string>();
      blocked.add(row.id);
      blocksOf.set(blocker, blocked);
    }
  }
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
