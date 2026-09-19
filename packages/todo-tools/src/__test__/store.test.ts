// 清单内核单元（docs/TODO.md §1.2/§1.4/§6）：CRUD 语义、数值序、metadata 合并、
// 依赖单源派生、deleted 清边与优先级、前置校验、深拷贝隔离、并发组。

import { describe, expect, it } from "vitest";
import { createTodoStore } from "../store.ts";
import type { TodoList } from "../tokens.ts";

/** 建任务于指定 store（返回 id 断言用） */
const make = (store: TodoList, subject = "Fix login bug", extra: Record<string, unknown> = {}): string => {
  const made = store.create({ subject, ...extra });
  if (!made.ok) throw new Error(`create failed: ${made.reason}`);
  return made.task.id;
};

describe("create / get / list 基础语义", () => {
  it("create 落 pending 初始态，id 从 1 递增", () => {
    const store = createTodoStore();
    const a = store.create({ subject: "A" });
    const b = store.create({ subject: "B", description: "d", activeForm: "Doing B", metadata: { k: 1 } });
    expect(a).toMatchObject({ ok: true, task: { id: "1", subject: "A", status: "pending", blocks: [], blockedBy: [] } });
    expect(b).toMatchObject({ ok: true, task: { id: "2", status: "pending", description: "d", activeForm: "Doing B" } });
  });

  it("get 回完整快照：可选字段在场，缺席字段无键", () => {
    const store = createTodoStore();
    store.create({ subject: "A", metadata: { a: 1 } });
    const got = store.get("1");
    if (!got.ok) throw new Error("unreachable");
    expect(got.task).toMatchObject({ id: "1", subject: "A", metadata: { a: 1 } });
    expect("description" in got.task).toBe(false);
    expect("activeForm" in got.task).toBe(false);
    expect("owner" in got.task).toBe(false);
  });

  it("get 未存在 id → not-found；list 空清单回 []", () => {
    const store = createTodoStore();
    expect(store.get("404")).toMatchObject({ ok: false, reason: "not-found" });
    expect(store.list()).toEqual([]);
  });

  it("list 按【数值】id 升序——11 条任务下字典序（\"10\"<\"2\"）必乱序的假绿防线", () => {
    const store = createTodoStore();
    for (let i = 1; i <= 11; i++) store.create({ subject: `T${i}` });
    expect(store.list().map((t) => t.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  });
});

describe("update 语义矩阵", () => {
  it("status 四值 set 语义：reopen（completed→pending）合法——工作流指引非校验规则", () => {
    const store = createTodoStore();
    const id = make(store);
    store.update(id, { status: "in_progress" });
    store.update(id, { status: "completed" });
    const reopened = store.update(id, { status: "pending" });
    expect(reopened).toMatchObject({ ok: true, task: { status: "pending" } });
  });

  it("subject/description/activeForm/owner 可更新；update 侧空 subject 拒（同 create）", () => {
    const store = createTodoStore();
    const id = make(store);
    const updated = store.update(id, { subject: "New", description: "nd", activeForm: "na", owner: "worker" });
    expect(updated).toMatchObject({ ok: true, task: { subject: "New", description: "nd", activeForm: "na", owner: "worker" } });
    expect(store.update(id, { subject: "" })).toMatchObject({ ok: false, reason: "invalid-args" });
  });

  it("空更新（仅 taskId）= 合法 no-op，回当前详情", () => {
    const store = createTodoStore();
    const id = make(store, "S");
    expect(store.update(id, {})).toMatchObject({ ok: true, task: { subject: "S", status: "pending" } });
  });

  it("create 侧空 subject 拒（语义必填单点住 store）", () => {
    expect(createTodoStore().create({ subject: "" })).toMatchObject({ ok: false, reason: "invalid-args" });
  });

  it("taskId 空串/含换行 → invalid-args（get 与 update 双侧）", () => {
    const store = createTodoStore();
    for (const bad of ["", "a\nb", "a\rb"]) {
      expect(store.get(bad)).toMatchObject({ ok: false, reason: "invalid-args" });
      expect(store.update(bad, {})).toMatchObject({ ok: false, reason: "invalid-args" });
    }
  });

  it("update 未存在 id → not-found", () => {
    expect(createTodoStore().update("9", { status: "completed" })).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("metadata 键级合并", () => {
  it("同名键覆盖；值为 null 删除该键；删光后字段缺席", () => {
    const store = createTodoStore();
    const id = make(store, "A", { metadata: { a: 1, b: 2, c: 3 } });
    const m1 = store.update(id, { metadata: { b: 20, c: null, d: 4 } });
    expect(m1).toMatchObject({ ok: true, task: { metadata: { a: 1, b: 20, d: 4 } } });
    const m2 = store.update(id, { metadata: { a: null, b: null, d: null } });
    if (!("task" in m2)) throw new Error("unreachable");
    expect("metadata" in m2.task).toBe(false);
  });

  it("create 的 metadata 原样入库（null 值合法——null 删键是 update 对既有键的合并语义）", () => {
    const store = createTodoStore();
    const made = store.create({ subject: "A", metadata: { k: null } });
    expect(made).toMatchObject({ ok: true, task: { metadata: { k: null } } });
    const gone = store.update("1", { metadata: { k: null } });
    if (!("task" in gone)) throw new Error("unreachable");
    expect("metadata" in gone.task).toBe(false);
  });

  it("不可克隆值（函数/symbol）→ invalid-args:metadata not cloneable，不崩溃", () => {
    const store = createTodoStore();
    expect(store.create({ subject: "A", metadata: { f: () => 1 } })).toMatchObject({ ok: false, reason: "invalid-args", message: "metadata not cloneable" });
    const id = make(store);
    expect(store.update(id, { metadata: { s: Symbol("x") } })).toMatchObject({ ok: false, reason: "invalid-args", message: "metadata not cloneable" });
  });

  it("深拷贝隔离：caller 入库后变异不穿透，出口快照变异不回写", () => {
    const store = createTodoStore();
    const input = { deep: { nested: 1 } };
    const id = make(store, "A", { metadata: input });
    input.deep.nested = 999;
    const got = store.get(id);
    if (!got.ok) throw new Error("unreachable");
    expect(got.task.metadata).toEqual({ deep: { nested: 1 } });
    const snap = store.list()[0];
    if (snap === undefined) throw new Error("unreachable");
    // 出口对象caller侧改写不回写内核
    (snap as { subject: string }).subject = "hacked";
    expect(store.get(id)).toMatchObject({ ok: true, task: { subject: "A" } });
  });
});

describe("依赖（单源边集，出口双侧派生）", () => {
  it("addBlockedBy 与 addBlocks 双侧互见且数值升序", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    make(store, "C");
    store.update("3", { addBlockedBy: ["1", "2"] });
    store.update("1", { addBlocks: ["3"] }); // 重复边——去重
    const b = store.get("1");
    const c = store.get("3");
    if (!b.ok || !c.ok) throw new Error("unreachable");
    expect(b.task.blocks).toEqual(["3"]);
    expect(c.task.blockedBy).toEqual(["1", "2"]);
  });

  it("引用未知 id 拒并点名；自引用拒（自阻塞即环）", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    expect(store.update("2", { addBlockedBy: ["1", "9"] })).toMatchObject({
      ok: false,
      reason: "invalid-args",
      message: "addBlockedBy references unknown task '9'",
    });
    expect(store.update("1", { addBlocks: ["1"] })).toMatchObject({
      ok: false,
      reason: "invalid-args",
      message: "addBlocks must not reference itself ('1')",
    });
    // 拒绝后零副作用：2 的依赖未部分落边
    const b = store.get("2");
    if (!b.ok) throw new Error("unreachable");
    expect(b.task.blockedBy).toEqual([]);
  });
});

describe("deleted 语义", () => {
  it("删除优先：status=deleted 与其余字段同传时余字段静默忽略", () => {
    const store = createTodoStore();
    make(store, "A");
    const result = store.update("1", { status: "deleted", subject: "x", addBlocks: ["99"] });
    expect(result).toEqual({ ok: true, deleted: true });
    expect(store.list()).toEqual([]);
  });

  it("删除后 get/update → not-found；id 不复用（下一任务跳号）", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update("1", { status: "deleted" });
    expect(store.get("1")).toMatchObject({ ok: false, reason: "not-found" });
    expect(store.update("1", { status: "completed" })).toMatchObject({ ok: false, reason: "not-found" });
    const next = store.create({ subject: "C" });
    expect(next).toMatchObject({ ok: true, task: { id: "3" } });
  });

  it("删除清边（反向）：删被阻塞任务后 blocker 的 blocks 为空，无悬空 id", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update("1", { addBlocks: ["2"] });
    store.update("2", { status: "deleted" });
    const a = store.get("1");
    if (!a.ok) throw new Error("unreachable");
    expect(a.task.blocks).toEqual([]);
  });

  it("删除清边：删 blocker 后被阻塞任务的 blockedBy 为空，无悬空 id", () => {
    const store = createTodoStore();
    make(store, "A");
    make(store, "B");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "deleted" });
    const b = store.get("2");
    if (!b.ok) throw new Error("unreachable");
    expect(b.task.blockedBy).toEqual([]);
  });
});

describe("并发组（钉死 store 全同步前提——parallel 声明的正确性依据）", () => {
  it("并发 create：id 连续唯一不重号", async () => {
    const store = createTodoStore();
    const createOne = (i: number) => Promise.resolve().then(() => store.create({ subject: `T${i}` }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => createOne(i)));
    const ids = results.map((r) => (r.ok ? r.task.id : "x"));
    expect(new Set(ids).size).toBe(20);
    expect(ids.sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  });

  it("并发 update 同任务：可序列化——最终态是某次完整写入，无字段丢失杂交", async () => {
    const store = createTodoStore();
    const id = make(store);
    const round = (i: number) => Promise.resolve().then(() => store.update(id, { subject: `S${i}`, owner: `o${i}` }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => round(i)));
    const got = store.get(id);
    if (!got.ok || got.task.owner === undefined) throw new Error("unreachable");
    // 同源断言：两字段轮次后缀一致——字段级交错（subject=S3+owner=o7 杂交）必挂
    expect(got.task.subject).toMatch(/^S\d$/);
    expect(got.task.subject.slice(1)).toBe(got.task.owner.slice(1));
  });

  it("并发 list：每次都是一致快照（条目数单调不减）", async () => {
    const store = createTodoStore();
    const counts: number[] = [];
    const createOne = (i: number) => Promise.resolve().then(() => store.create({ subject: `T${i}` }));
    const countOnce = () => Promise.resolve().then(() => counts.push(store.list().length));
    await Promise.all([...Array.from({ length: 10 }, (_, i) => createOne(i)), ...Array.from({ length: 10 }, () => countOnce())]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1] as number);
  });
});
