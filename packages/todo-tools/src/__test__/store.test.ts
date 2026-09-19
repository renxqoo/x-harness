// 清单内核单元（docs/TODO.md §1.2/§1.4/§6）：CRUD 语义、数值序、metadata 合并、
// 依赖单源派生、deleted 清边与优先级、前置校验、深拷贝隔离、并发组。

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@x-harness/session";
import { createTodoStore } from "../store.ts";
import type { TodoList } from "../tokens.ts";

/** 建任务于指定 store（返回 id 断言用） */
const make = (store: TodoList, subject = "Fix login bug", extra: Record<string, unknown> = {}): string => {
  const made = store.create(undefined, { subject, ...extra });
  if (!made.ok) throw new Error(`create failed: ${made.reason}`);
  return made.task.id;
};

describe("create / get / list 基础语义", () => {
  it("create 落 pending 初始态，id 从 1 递增", () => {
    const store = createTodoStore();
    const a = store.create(undefined, { subject: "A" });
    const b = store.create(undefined, { subject: "B", description: "d", activeForm: "Doing B", metadata: { k: 1 } });
    expect(a).toMatchObject({ ok: true, task: { id: "1", subject: "A", status: "pending", blocks: [], blockedBy: [] } });
    expect(b).toMatchObject({ ok: true, task: { id: "2", status: "pending", description: "d", activeForm: "Doing B" } });
  });

  it("get 回完整快照：可选字段在场，缺席字段无键", () => {
    const store = createTodoStore();
    store.create(undefined, { subject: "A", metadata: { a: 1 } });
    const got = store.get(undefined, "1");
    if (!got.ok) throw new Error("unreachable");
    expect(got.task).toMatchObject({ id: "1", subject: "A", metadata: { a: 1 } });
    expect("description" in got.task).toBe(false);
    expect("activeForm" in got.task).toBe(false);
    expect("owner" in got.task).toBe(false);
  });

  it("get 未存在 id → not-found；list 空清单回 []", () => {
    const store = createTodoStore();
    expect(store.get(undefined, "404")).toMatchObject({ ok: false, reason: "not-found" });
    expect(store.list(undefined)).toEqual([]);
  });

  it("list 按【数值】id 升序——11 条任务下字典序（\"10\"<\"2\"）必乱序的假绿防线", () => {
    const store = createTodoStore();
    for (let i = 1; i <= 11; i++) store.create(undefined, { subject: `T${i}` });
    expect(store.list(undefined).map((t) => t.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  });
});

describe("update 语义矩阵", () => {
  it("status 四值 set 语义：reopen（completed→pending）合法——工作流指引非校验规则", () => {
    const store = createTodoStore();
    const id = make(store);
    store.update(undefined, id, { status: "in_progress" });
    store.update(undefined, id, { status: "completed" });
    const reopened = store.update(undefined, id, { status: "pending" });
    expect(reopened).toMatchObject({ ok: true, task: { status: "pending" } });
  });

  it("subject/description/activeForm/owner 可更新；update 侧空 subject 拒（同 create）", () => {
    const store = createTodoStore();
    const id = make(store);
    const updated = store.update(undefined, id, { subject: "New", description: "nd", activeForm: "na", owner: "worker" });
    expect(updated).toMatchObject({ ok: true, task: { subject: "New", description: "nd", activeForm: "na", owner: "worker" } });
    expect(store.update(undefined, id, { subject: "" })).toMatchObject({ ok: false, reason: "invalid-args" });
  });

  it("空更新（仅 taskId）= 合法 no-op，回当前详情", () => {
    const store = createTodoStore();
    const id = make(store, "S");
    expect(store.update(undefined, id, {})).toMatchObject({ ok: true, task: { subject: "S", status: "pending" } });
  });

  it("create 侧空 subject 拒（语义必填单点住 store）", () => {
    expect(createTodoStore().create(undefined, { subject: "" })).toMatchObject({ ok: false, reason: "invalid-args" });
  });

  it("taskId 空串/含换行 → invalid-args（get 与 update 双侧）", () => {
    const store = createTodoStore();
    for (const bad of ["", "a\nb", "a\rb"]) {
      expect(store.get(undefined, bad)).toMatchObject({ ok: false, reason: "invalid-args" });
      expect(store.update(undefined, bad, {})).toMatchObject({ ok: false, reason: "invalid-args" });
    }
  });

  it("update 未存在 id → not-found", () => {
    expect(createTodoStore().update(undefined, "9", { status: "completed" })).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("metadata 键级合并", () => {
  it("同名键覆盖；值为 null 删除该键；删光后字段缺席", () => {
    const store = createTodoStore();
    const id = make(store, "A", { metadata: { a: 1, b: 2, c: 3 } });
    const m1 = store.update(undefined, id, { metadata: { b: 20, c: null, d: 4 } });
    expect(m1).toMatchObject({ ok: true, task: { metadata: { a: 1, b: 20, d: 4 } } });
    const m2 = store.update(undefined, id, { metadata: { a: null, b: null, d: null } });
    if (!("task" in m2)) throw new Error("unreachable");
    expect("metadata" in m2.task).toBe(false);
  });

  it("create 的 metadata 原样入库（null 值合法——null 删键是 update 对既有键的合并语义）", () => {
    const store = createTodoStore();
    const made = store.create(undefined, { subject: "A", metadata: { k: null } });
    expect(made).toMatchObject({ ok: true, task: { metadata: { k: null } } });
    const gone = store.update(undefined, "1", { metadata: { k: null } });
    if (!("task" in gone)) throw new Error("unreachable");
    expect("metadata" in gone.task).toBe(false);
  });

  it("不可克隆值（函数/symbol）→ invalid-args:metadata not cloneable，不崩溃", () => {
    const store = createTodoStore();
    expect(store.create(undefined, { subject: "A", metadata: { f: () => 1 } })).toMatchObject({ ok: false, reason: "invalid-args", message: "metadata not cloneable" });
    const id = make(store);
    expect(store.update(undefined, id, { metadata: { s: Symbol("x") } })).toMatchObject({ ok: false, reason: "invalid-args", message: "metadata not cloneable" });
  });

  it("深拷贝隔离：caller 入库后变异不穿透，出口快照变异不回写", () => {
    const store = createTodoStore();
    const input = { deep: { nested: 1 } };
    const id = make(store, "A", { metadata: input });
    input.deep.nested = 999;
    const got = store.get(undefined, id);
    if (!got.ok) throw new Error("unreachable");
    expect(got.task.metadata).toEqual({ deep: { nested: 1 } });
    const snap = store.list(undefined)[0];
    if (snap === undefined) throw new Error("unreachable");
    // 出口对象caller侧改写不回写内核
    (snap as { subject: string }).subject = "hacked";
    expect(store.get(undefined, id)).toMatchObject({ ok: true, task: { subject: "A" } });
  });
});

describe("依赖（单源边集，出口双侧派生）", () => {
  it("addBlockedBy 与 addBlocks 双侧互见且数值升序", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    make(store, "C");
    store.update(undefined, "3", { addBlockedBy: ["1", "2"] });
    store.update(undefined, "1", { addBlocks: ["3"] }); // 重复边——去重
    const b = store.get(undefined, "1");
    const c = store.get(undefined, "3");
    if (!b.ok || !c.ok) throw new Error("unreachable");
    expect(b.task.blocks).toEqual(["3"]);
    expect(c.task.blockedBy).toEqual(["1", "2"]);
  });

  it("引用未知 id 拒并点名；自引用拒（自阻塞即环）", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    expect(store.update(undefined, "2", { addBlockedBy: ["1", "9"] })).toMatchObject({
      ok: false,
      reason: "invalid-args",
      message: "addBlockedBy references unknown task '9'",
    });
    expect(store.update(undefined, "1", { addBlocks: ["1"] })).toMatchObject({
      ok: false,
      reason: "invalid-args",
      message: "addBlocks must not reference itself ('1')",
    });
    // 拒绝后零副作用：2 的依赖未部分落边
    const b = store.get(undefined, "2");
    if (!b.ok) throw new Error("unreachable");
    expect(b.task.blockedBy).toEqual([]);
  });
});

describe("deleted 语义", () => {
  it("删除优先：status=deleted 与其余字段同传时余字段静默忽略", () => {
    const store = createTodoStore();
    make(store, "A");
    const result = store.update(undefined, "1", { status: "deleted", subject: "x", addBlocks: ["99"] });
    expect(result).toEqual({ ok: true, deleted: true });
    expect(store.list(undefined)).toEqual([]);
  });

  it("删除后 get/update → not-found；id 不复用（下一任务跳号）", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update(undefined, "1", { status: "deleted" });
    expect(store.get(undefined, "1")).toMatchObject({ ok: false, reason: "not-found" });
    expect(store.update(undefined, "1", { status: "completed" })).toMatchObject({ ok: false, reason: "not-found" });
    const next = store.create(undefined, { subject: "C" });
    expect(next).toMatchObject({ ok: true, task: { id: "3" } });
  });

  it("删除清边（反向）：删被阻塞任务后 blocker 的 blocks 为空，无悬空 id", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update(undefined, "1", { addBlocks: ["2"] });
    store.update(undefined, "2", { status: "deleted" });
    const a = store.get(undefined, "1");
    if (!a.ok) throw new Error("unreachable");
    expect(a.task.blocks).toEqual([]);
  });

  it("删除清边：删 blocker 后被阻塞任务的 blockedBy 为空，无悬空 id", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update(undefined, "2", { addBlockedBy: ["1"] });
    store.update(undefined, "1", { status: "deleted" });
    const b = store.get(undefined, "2");
    if (!b.ok) throw new Error("unreachable");
    expect(b.task.blockedBy).toEqual([]);
  });
});

describe("并发组（钉死 store 全同步前提——parallel 声明的正确性依据）", () => {
  it("并发 create：id 连续唯一不重号", async () => {
    const store = createTodoStore();
    const createOne = (i: number) => Promise.resolve().then(() => store.create(undefined, { subject: `T${i}` }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => createOne(i)));
    const ids = results.map((r) => (r.ok ? r.task.id : "x"));
    expect(new Set(ids).size).toBe(20);
    expect(ids.sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  });

  it("并发 update 同任务：可序列化——最终态是某次完整写入，无字段丢失杂交", async () => {
    const store = createTodoStore();
    const id = make(store);
    const round = (i: number) => Promise.resolve().then(() => store.update(undefined, id, { subject: `S${i}`, owner: `o${i}` }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => round(i)));
    const got = store.get(undefined, id);
    if (!got.ok || got.task.owner === undefined) throw new Error("unreachable");
    // 同源断言：两字段轮次后缀一致——字段级交错（subject=S3+owner=o7 杂交）必挂
    expect(got.task.subject).toMatch(/^S\d$/);
    expect(got.task.subject.slice(1)).toBe(got.task.owner.slice(1));
  });

  it("并发 list：每次都是一致快照（条目数单调不减）", async () => {
    const store = createTodoStore();
    const counts: number[] = [];
    const createOne = (i: number) => Promise.resolve().then(() => store.create(undefined, { subject: `T${i}` }));
    const countOnce = () => Promise.resolve().then(() => counts.push(store.list(undefined).length));
    await Promise.all([...Array.from({ length: 10 }, (_, i) => createOne(i)), ...Array.from({ length: 10 }, () => countOnce())]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1] as number);
  });
});

describe("快照导出与惰性恢复（修订B §13.1/§13.4）", () => {
  const snapEvent = (data: unknown): SessionEvent => ({ type: "todo/snapshot", data }) as SessionEvent;

  it("snapshotOf 桶闭包全量导出：seq/tasks/edges 与桶状态一致", () => {
    const store = createTodoStore();
    const id = make(store, "A");
    make(store, "B");
    store.update(undefined, id, { status: "in_progress", owner: "w", metadata: { k: 1 } });
    store.update(undefined, "2", { addBlockedBy: ["1"] });
    const snap = store.snapshotOf(undefined);
    expect(snap.seq).toBe(2);
    expect(snap.tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(snap.tasks[1]?.owner).toBeUndefined();
    expect(snap.edges).toEqual([["1", "2"]]);
  });

  it("restore last-wins 灌桶：依赖边双向派生恢复、seq 延续、可选字段缺席保持", () => {
    const store = createTodoStore();
    const events = [
      snapEvent({ seq: 1, tasks: [{ id: "1", subject: "A", status: "pending" }], edges: [] }),
      snapEvent({ seq: 3, tasks: [{ id: "1", subject: "A", status: "completed", owner: "w" }, { id: "3", subject: "C", status: "pending" }], edges: [["1", "3"]] }),
    ];
    store.restore(undefined, () => events);
    const list = store.list(undefined);
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ id: "1", status: "completed", owner: "w" });
    expect(list[1]).toMatchObject({ id: "3", blockedBy: ["1"] });
    expect("description" in (list[0] as object)).toBe(false);
    const next = store.create(undefined, { subject: "D" });
    expect(next).toMatchObject({ ok: true, task: { id: "4" } }); // seq=3 延续
  });

  it("restore 深拷贝：恢复后 update 可变更（卷内冻结对象不穿透为 row 引用）", () => {
    const store = createTodoStore();
    store.restore(undefined, () => [snapEvent({ seq: 1, tasks: [{ id: "1", subject: "A", status: "pending", metadata: { k: 1 } }], edges: [] })]);
    const changed = store.update(undefined, "1", { subject: "A2" });
    expect(changed).toMatchObject({ ok: true, task: { subject: "A2" } });
    const cleared = store.update(undefined, "1", { metadata: { k: null } });
    expect(cleared.ok && !("deleted" in cleared) && "metadata" in cleared.task).toBe(false);
  });

  it("桶在场即不再 fold：变更后 restore 不覆盖内存态（含 append 失败期间保留的桶内状态）", () => {
    const store = createTodoStore();
    make(store, "A");
    store.update(undefined, "1", { status: "in_progress" });
    store.restore(undefined, () => [snapEvent({ seq: 5, tasks: [{ id: "5", subject: "stale", status: "pending" }], edges: [] })]);
    const list = store.list(undefined);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ id: "1", status: "in_progress" });
  });

  it("空卷/无快照事件 → 全新桶；restore 幂等（逐出后同卷重 fold 结果全等）", () => {
    const store = createTodoStore();
    store.restore(undefined, () => []);
    store.restore(undefined, () => [{ type: "user/message", data: {} } as SessionEvent]);
    expect(store.list(undefined)).toEqual([]);
    const events = [snapEvent({ seq: 2, tasks: [{ id: "1", subject: "A", status: "pending" }, { id: "2", subject: "B", status: "pending" }], edges: [["1", "2"]] })];
    store.restore(undefined, () => events);
    const once = store.snapshotOf(undefined);
    store.restore(undefined, () => events); // 桶在场跳过——快照不变
    expect(store.snapshotOf(undefined)).toEqual(once);
    store.evict(undefined as never); // 真幂等：逐出后同卷重 fold 结果全等
    store.restore(undefined, () => events);
    expect(store.snapshotOf(undefined)).toEqual(once);
  });

  it("evict 逐出：同会话再触达 = 新桶（id 从 1 重计）；他桶不受波及", () => {
    const store = createTodoStore();
    const a1 = store.create("sess-a" as never, { subject: "A1" });
    expect(a1).toMatchObject({ ok: true, task: { id: "1" } });
    store.evict("sess-a" as never);
    expect(store.list("sess-a" as never)).toEqual([]); // 逐出生效（非 no-op）
    const rebuilt = store.create("sess-a" as never, { subject: "A1-new" });
    expect(rebuilt).toMatchObject({ ok: true, task: { id: "1" } }); // 新桶 id 从 1 重计
    store.evict("sess-x" as never);
    expect(store.list("sess-a" as never).length).toBe(1); // 键控逐出不波及他桶
  });

  it("多桶隔离：两会话各自清单、id 各自从 1、依赖跨桶不可引用", () => {
    const store = createTodoStore();
    const a1 = store.create("sess-a" as never, { subject: "A1" });
    const b1 = store.create("sess-b" as never, { subject: "B1" });
    expect(a1).toMatchObject({ ok: true, task: { id: "1" } });
    expect(b1).toMatchObject({ ok: true, task: { id: "1" } });
    expect(store.get("sess-a" as never, "1")).toMatchObject({ ok: true, task: { subject: "A1" } });
    expect(store.list("sess-b" as never).length).toBe(1);
    // B 桶无 id 2——A 桶的 2 不可跨桶依赖（桶内引用闭合）
    store.create("sess-a" as never, { subject: "A2" });
    expect(store.update("sess-b" as never, "1", { addBlockedBy: ["2"] })).toMatchObject({ ok: false, reason: "invalid-args" });
  });

  it("服务面读探测零副作用：get/list/snapshotOf 不建桶——工具面惰性恢复不被劫持（收口审查 B-P1-1 回归锚）", () => {
    const store = createTodoStore();
    const events = [snapEvent({ seq: 2, tasks: [{ id: "1", subject: "A", status: "pending" }, { id: "2", subject: "B", status: "pending" }], edges: [] })];
    // 宿主经服务面探测（not-found / 空清单）——不得创建空桶
    expect(store.get("s" as never, "1")).toMatchObject({ ok: false, reason: "not-found" });
    expect(store.list("s" as never)).toEqual([]);
    expect(store.snapshotOf("s" as never)).toEqual({ seq: 0, tasks: [], edges: [] });
    store.restore("s" as never, () => events); // 之后工具面恢复仍生效
    expect(store.list("s" as never).length).toBe(2);
  });
});

describe("快照往返矩阵（收口审查回补——description/activeForm/owner/metadata 全字段往返）", () => {
  it("snapshotOf → restore 全字段保真：可选字段在场与缺席两态", () => {
    const store = createTodoStore();
    const id1 = make(store, "A", { description: "d1", activeForm: "af1" });
    const id2 = make(store, "B", { metadata: { k: [1, { nested: null }] } });
    store.update(undefined, id1, { owner: "w", status: "in_progress" });
    store.update(undefined, id2, { addBlockedBy: [id1] });
    store.update(undefined, id2, { addBlockedBy: [id1] }); // 已有 1→2；再造多 blocker 排序面
    const id3 = make(store, "C");
    store.update(undefined, id2, { addBlockedBy: [id3] });
    const snap = store.snapshotOf(undefined);
    expect(snap.edges.length).toBe(2); // 两个 blocker（1、3）→ 边按数值序导出
    const revived = createTodoStore();
    revived.restore(undefined, () => [{ type: "todo/snapshot", data: snap } as SessionEvent]);
    expect(revived.snapshotOf(undefined)).toEqual(snap); // 导出→恢复→再导出全等
    const got = revived.get(undefined, id2);
    expect(got).toMatchObject({ ok: true, task: { blockedBy: [id1, id3], metadata: { k: [1, { nested: null }] } } });
    expect("activeForm" in (got.ok ? got.task : {})).toBe(false); // 缺席字段恢复后仍缺席
  });
});
