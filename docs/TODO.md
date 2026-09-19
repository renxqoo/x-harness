# TODO：任务清单件（件 15）

> 状态：**修订B 已实施**（§1–§11 为初版口径，其中共享清单裁决已由 §13 修订B 撤销——
> 各节撤销指针见文内注记；两轮四路审查处置见 §9/§10/§13.6/§14）
> 级别：中（todo-tools 新包 + 4 个 LLM 可见新工具 + e2e 旅程）
> 规格：`/Users/wrr/work/claude-tool/task-tools.md`（Claude Code Task 工具族中的 4 个
> 任务清单动词；另 2 个后台任务动词已由件14 task_output/task_stop 兑现）。
> 用户指令（2026-09-19）：实现 Task 插件（todo 待办事项），**参数和提示词与规格一样**。
> 上游落档兑现：TASKS.md §9「任务枚举/清单工具（/tasks 面）→ 后续任务件」即本件。

## 0. 目标与边界

todo 清单四动词落地为独立插件 `@x-harness/todo-tools`：`task_create` / `task_get` /
`task_list` / `task_update`。**LLM 可见面 = 这四个工具，别无其他**。参数 schema
（参数集、per-param description、enum、required 面）与工具 description 正文对齐
规格（用户指令）；本仓事实冲突处按类别落档（§2）。

不做（落档 §7）：~~持久化/resume 恢复、会话隔离~~（持久化与 per-session 归属已由 §13 修订B
兑现——其余三条维持）、环检测、UI 观察面/事件总线、条目数帽。

## 1. 契约

### 1.1 工具面（todo-tools 注册；inject ["tools"]）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `task_create` | `{subject, description?, activeForm?, metadata?}` | 创建任务，状态一律 `pending`；回执含新 id |
| `task_get` | `{taskId}` | 按 id 读单个任务完整详情 |
| `task_list` | `{}` | 全部任务 + 阻塞关系，**数值 id 升序** |
| `task_update` | `{taskId, subject?, description?, activeForm?, status?, owner?, metadata?, addBlocks?, addBlockedBy?}` | 更新状态/字段/依赖/认领人；回执更新后详情 |

**schema 语义**（对齐规格原文形态）：

- `task_create`：required 为空（规格原样——四参数 schema 层全可选）但**语义上 subject
  必填**：空/缺席 → execute 层 `invalid-args:subject must be a non-empty string`；
- `task_get` / `task_update`：`taskId` required（规格表格必填项；缺席 = TypeBox 校验层拒）；
  空串/含换行 → execute 层 invalid-args（对齐件14 task_id 前置口径）；
- `task_update` 侧 `subject` 非空校验**同 create**（空串拒绝——update 不是清空标题的通道）；
- `status` enum：`pending | in_progress | completed | deleted`；
- `metadata`：`Record<string, unknown>`；
- per-param description 逐字取规格 Schema description 列（用户指令：参数一样），§6 全量对账。

**并发档**：四工具全 parallel（store 操作全同步、execute 无 await 竞态窗口——
`isConcurrencySafe: () => true`，对齐 task_output 先例；同步性由 §6 并发组用例钉死）。

### 1.2 状态与更新语义

- **status 是 set 语义**，不强制单向流转：规格「Status progresses: pending →
  in_progress → completed」描述的是工作流指引而非校验规则——reopen（completed 回
  pending）是合法操作，模型侧描述已引导正向流转，工具层不加校验（落档裁决）；
- `deleted` = **永久移除**（规格 "permanently removes"）：**删除优先**——status=deleted
  与其余 patch 字段同传时，余字段静默忽略、直接删除（无「先改后删」中间态）；删除后
  get/update 该 id → not-found；**id 不复用**（计数器单调递增，deleted 后空洞保留）；
  删除时同步清理他任务依赖边里的悬空引用（否则 TaskList 渲染出已删 id）；
- `metadata` **键级合并**（规格明写）：update 的 metadata 同名键覆盖，值为 `null` 删除
  该键；create 的 metadata 原样入库（null 值合法——「null 删键」是 update 对**既有键**
  的合并语义，create 无既有键可删，原样即降级；对 create 即 null 的键后续 update 传
  null 删掉它，自洽）；
- `addBlocks` / `addBlockedBy`：**追加去重**（不替换既有依赖）；引用清单中不存在的
  taskId（含自身 id——自阻塞即环）→ `invalid-args` 拒绝并点名未知 id（fail-closed：
  静默忽略会让模型误以为依赖已建立）；
- 空更新（仅 taskId，无任何字段）→ 合法 no-op，回执当前详情；
- **不检测依赖环**（A→B→A）：规格未定义，描述未承诺；环的后果是两条任务互相
  blocked（TaskList 如实呈现），模型可自纠（落档 §7）。

### 1.3 清单边界（**已由 §13 修订B 撤销——清单改每会话一份**；以下为初版口径，保留决策痕迹）

- ~~**共享清单**（装配内单例，非会话键控）~~【撤销：该语义无生产消费方——§13.1】规格 §8 多代理协作语义——owner 认领、
  「各代理通过 TaskList 领取无主、未阻塞的 pending 任务」——要求跨会话可见。
  本仓 agent-delegation 子代理是独立 session，会话键控会切断该协作面。与
  BackgroundTasks 会话键控的差异落档：后台任务是**进程资源**（有属主/杀灭边界），
  todo 清单是**协作载体**（属主是清单内容的一个字段，不是访问边界）；
- 无 session 调用方（非 agent）可用（对齐 read/write「非 agent 调用方可用」先例；
  与件14 task_output 拒无 session 的口径**有意相反**——那边 task_id 属主判定需要
  session，本件清单无属主边界）；
- **不持久化**：清单生命周期 = 插件装配生命周期；会话 resume / 进程重启后清单为空
  （对齐 TASKS.md §9「任务持久化/跨重启任务面 → 后续件」先例）。

### 1.4 服务面（单一真相 + 终态断言口）

```ts
export interface TodoTask {
  readonly id: string;                       // 十进制递增字符串 "1","2",…
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed";   // 无 deleted 态——deleted 即移除
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly blocks: readonly string[];        // 它阻塞谁（数值 id 升序）
  readonly blockedBy: readonly string[];     // 它被谁阻塞（数值 id 升序）
}
export interface TodoList {
  create(input: { subject: string; description?: string; activeForm?: string; metadata?: Record<string, unknown> }): { ok: true; task: TodoTask };
  get(taskId: string): { ok: true; task: TodoTask } | { ok: false; reason: "not-found" };
  list(): readonly TodoTask[];               // 数值 id 升序
  update(taskId: string, patch: TodoUpdatePatch): { ok: true; task: TodoTask } | { ok: false; reason: "not-found" | "invalid-args"; message?: string };
}
```

- **排序一律数值序**（Number(id) 比较）：id 是十进制递增字符串，字典序下 "10" < "2"——
  list 与 blocks/blockedBy 快照全部按数值序（TaskList 描述 "lowest ID first" 的数值语义）；
- **依赖单源存储**：内部只存有向边集（A blocks B）；每任务的 blocks/blockedBy 出口
  派生——双向同步无撕裂面（写入只动一处）；
- 入库 `structuredClone` 深拷贝、出口快照新对象（防 caller 引用变异穿透）；clone 失败
  （metadata 含函数/symbol 等不可克隆值——服务面/直连可达，工具面 JSON.parse 不可达）
  → 拒 `invalid-args:metadata not cloneable`（降级不崩溃的仓规口径）；
- **服务面信任边界**：类型即契约——**语义校验与最小形状防御（空 subject / taskId
  形状 / 依赖引用存在性）单点住 store**（get/update 对垃圾 taskId 回 invalid-args），
  工具面只铸文；宿主绕过 TypeScript 传深层垃圾（数组 metadata、非串 subject）= 宿主
  bug，服务面不防（cloneable 守卫是唯一例外，因其崩溃而非类型问题）；
- 服务 token `todoList`（defineService）；e2e/宿主经 `ctx.use(todoList)` 断言终态
  （对齐 taskHub 先例）。

### 1.5 铸文（工具回执）

- `task_create` → `Created task <id>: <subject> (status: pending)`；
- `task_get` / `task_update`（非 deleted）→ 任务卡片（字段缺席省行）：
  `Task <id>: <subject>` / `Status: <status>` / `Owner:` / `Description:` /
  `Active form:` / `Metadata: <JSON>` / `Blocks: <ids>` / `Blocked by: <ids>`；
  Metadata 序列化 throw（BigInt 等经服务面入库的合法值）→ `<unserializable>` 占位降级；
- `task_update`（status=deleted）→ `Deleted task <id>`；
- `task_list` → 一行一任务（数值 id 升序）：`<id>. [<status>] <subject>` + 注记
  `(owner: <owner>; blocks: <ids>; blocked by: <ids>)`（在场才写，三段独立）；
  空清单 → `No tasks`；
- 错误词表对齐件14 风格：`not-found:<taskId>; no such task`（分号口径同件14）；
  `invalid-args:<详情>`（冒号）。

## 2. 描述文案纪律（用户指令：提示词一样）

`descriptions.ts` 四条正文 = 规格「完整原始 description（英文原文）」，偏离按类别落档：

- **① 描述内工具名引用改写为本仓实名**：原文 Tips 里 "use TaskUpdate to set up
  dependencies" / "Check TaskList first" / "read a task's latest state using TaskGet"
  三处驼峰名 → `task_update` / `task_list` / `task_get`（本仓注册名；件14 把 id 来源
  括注改写为本仓实名的同款先例——指称的工具必须在工具列表里存在）；
- **② schema 不设 `additionalProperties: false`**（规格有）：本仓校验层 schema 探活对
  布尔值 additionalProperties 节点 throw（validate.ts NODE_KEYS 巡检），仓内全部工具
  均不设、多余键放行——实现层口径，非参数语义偏离；
- **③ 张力提法保留原文、语义以实现为准**（落档不改写）：TaskCreate 首句 "for your
  current coding session"（实现是装配内共享清单——§1.3，非单会话）；activeForm 参数
  description "shown in spinner"（本仓无 spinner 展示面，字段照存）；「Plan mode」
  场景行（本仓无 plan mode，场景指引无害——工具真实存在）。用户指令优先逐字。

对账测试锁死（§6）：四条正文锚词 + **per-param description 全量逐字对账**（14 条
参数描述 vs 规格表格列，非取样锚）+ 参数面双向对账（描述承诺的参数 schema 必有、
schema 有的参数描述必提——件14 descriptions.test 先例）+ **enum/必填面从表格列解析
对账**（status 四值 ↔ Union literals；✅ 列 ↔ required——create 特例按规格注记 required
为空）。spec 快照入仓 `src/__test__/fixtures/task-tools.spec.md`（来源即上述仓外文件，
上游更新时手动重拷——门禁不绑单机路径，机器绑定债不随本件扩大）。

## 3. 拆分与依赖

```text
packages/todo-tools（新；依赖 core[Plugin/Context/defineService] + tools[ToolDefinition/toolRegistry]）
  tokens.ts（todoList 服务 + TodoTask/TodoList/TodoUpdatePatch 类型）
  store.ts（createTodoStore——清单内核：CRUD/依赖单源边集/deleted 清边/深拷贝/数值序）
  tools.ts（四工具 + 铸文）
  descriptions.ts（规格原文四条，工具名引用改写）
  plugin.ts（createTodoToolsPlugin()：name "todo-tools"，inject ["tools"]，
    provide todoList + 注册四工具，摘除经 ctx.effect）
  __test__/（store/tools/plugin/descriptions 四套）

packages/e2e/src/todo-journey.ts（新旅程，挂 main.ts 默认门）
docs/TASKS.md（§9 兑现注记一行）
```

依赖方向：todo-tools → core/tools。无环；不依赖 session（共享清单无会话语义）。
tool-core/tool-read 等命令包零改动；task-tools 零改动。

## 4. 实施顺序

A. todo-tools 包全量（store + 服务 + 四工具 + 描述 + 四套单测）——四门绿。
B. e2e 旅程（真实 agent turn 驱动 create → in_progress → 依赖 → list → complete →
   deleted 收尾全链 + 服务快照终态断言）+ TASKS.md 注记——四门绿。
每步独立提交可回滚；收口前两路对抗审查（仓规）。

## 5. 裁决（共享清单一行已由 §13 修订B 撤销；其余维持）

- **用户裁决**：参数与提示词对齐规格（原始指令「参数和提示词一样就好」；工具名
  引用改写与张力提法保留是「对齐本仓实名/逐字」的推论，见 §2）。
- 默认裁决（否决窗口内可推翻）：
  - 工具名小写蛇形 `task_create` 族（规格 TaskCreate 家族命名 + 本仓 bash/read/write
    小写化先例——模型侧家族性与仓内命名规约同时成立）；
  - ~~共享清单非会话键控（规格 §8 协作语义——见 §1.3 论据）~~【撤销——§13.1 per-session】；
  - 不持久化（TASKS.md §9 先例）；
  - status set 语义不强制单向（§1.2 论据）；
  - 依赖引用未知 id 拒绝（fail-closed 仓规）；
  - deleted 优先（§1.2）；
  - 包名 `todo-tools`（task-tools 名额被件14 占用，一事一包）。

## 6. 测试口径

- **契约级**：四工具参数面 == 规格参数表（表驱动双向对账：参数名/必填面/enum）；
  **per-param description 全量逐字对账**（14 条 vs 规格表格列）；描述锚词（四条正文
  取样锚 + 工具名实名锚：描述里的 task_update/task_list/task_get 提法在场、驼峰名绝迹）；
  并发档声明 parallel；服务类型判别联合穷举（ok/not-found/invalid-args 各至少一条）；
- **CRUD 全生命周期**：create（pending 初始态/回执含 id）→ get（卡片全字段）→
  update（subject/description/activeForm/owner/status 四值矩阵）→ list（升序/注记/
  空清单）；
- **排序假绿防线**：≥11 条任务的 list 数值序用例（字典序 "10"<"2" 必挂——防默认
  sort 假绿）；blocks/blockedBy 快照同口径；
- **metadata**：合并覆盖 / null 删键 / create 原样含 null / 不可克隆值拒
  （函数值 → invalid-args:metadata not cloneable，不崩溃）；
- **依赖**：addBlocks/addBlockedBy 单源派生双侧互见 / 追加去重 / 未知 id 拒（点名
  未知 id）/ 自引用拒 / 删除清边（删 1 后 2 的 blockedBy 空）；
- **deleted**：该次调用回执 `Deleted task <id>` / 后续 get/update not-found /
  id 不复用（下一任务 id 跳号）/ deleted 与字段同传 = 删除优先；
- **前置校验**：subject 空/缺席拒（create 与 update 双侧）；taskId 空串/含换行拒；
  task_update 全字段缺席 = no-op 回执详情；
- **并发组**：并发 create（Promise.all 多路）id 连续唯一；并发 update 同任务字段
  不丢失（后写覆盖有序可序列化）；并发 list 一致快照——钉死「store 全同步」前提；
- **无 session 直连**：dispatch 不带 `session` 字段调用四工具全通过（共享清单回归锚）；
- **装配**：inject 拓扑（tools 先行）/ 注册摘除往返（dispose 后四工具 registry 消失 +
  dispatch → unknown-tool + ctx.use(todoList) throw not provided——负向边界锁）/
  apply 中途 throw 回卷（预注册 task_create 后装配 → 整体失败 → registry 空 +
  tryUse(todoList) undefined）；
- ~~**共享语义锚**：两个不同 session 的调用方互相可见对方创建的任务~~【§13.4 反转为隔离断言】；
- **e2e**：真实 agent turn 四动词全链（create → in_progress → 依赖建立 → list →
  complete → deleted → 删后 not-found 收尾）+ tool/result 事件落账数量 + 铸文锚
  （list 行格式 / blocked by 注记 / Deleted 回执）+ `ctx.use(todoList)` 终态断言。

## 7. 不处理（落档）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 持久化 / resume 后清单恢复 | 生命周期 = 装配（TASKS.md §9 先例） | 后续件 |
| 依赖环检测 | 规格未定义、描述未承诺；模型可自纠 | 本件裁定 |
| UI 观察面 / 总线事件（todo 变更通知） | 无消费面 | UI 件 |
| 会话隔离 | 协作语义要求共享（§1.3） | 本件裁定 |
| subject/metadata 长度帽与条目数帽 | 内存态 + 装配生命周期，无放大面 | 本件裁定 |
| metadata 深合并 | 规格是键级合并 | 本件裁定 |
| schema additionalProperties: false | 校验层探活不支持布尔节点（§2②） | 本仓校验层口径 |
| 服务面形状守卫（cloneable 除外） | 类型即契约，宿主绕过类型 = 宿主 bug | 本件裁定 |

## 8. 验收清单

- [x] §1 契约逐条（四工具参数面 == 规格表、铸文、并发档、服务面）
- [x] §6 测试口径逐条落地全绿
- [x] 四门 + 覆盖率数字如实报告（§11）；e2e 旅程绿
- [x] 对抗审查（定稿前 + 收口前各 ≥2 路）问题清零（§9/§10）

## 9. 定稿前对抗审查处置（两路并行，19 项全处置）

**路 A（契约/语义对照面）**：A1 描述内驼峰工具名引用错位 → **采纳**：§2① 改写本仓
实名。A2 deleted 回执缺失 → **采纳**：`Deleted task <id>`（§1.5）。A3 per-param
description 无验收锚 → **采纳**：全量逐字对账（§2/§6）。A4 task_list 注记缺 blocks
方向 → **采纳**：注记三段（owner/blocks/blocked by）（§1.5）。A5 字典序乱序 →
**采纳**：数值序钉死（§1.4）+ ≥11 条用例（§6）。A6 not-found 分隔符与件14 不一致 →
**采纳**：分号口径（§1.5）。A7 coding session/spinner/Plan mode 张力未落档 →
**采纳**：§2③ 保留原文 + 语义以实现为准。A8 create null 与 update 删键分叉 →
**落档**：null 删键是 update 对既有键的合并语义，create 原样即降级，自洽（§1.2）。
A9 服务面信任边界 → **落档**（§1.4）。A10 deleted 组合语义 → **采纳**：删除优先
（§1.2）。A11 铸文锚未入测试口径 → **采纳**（§6）。

**路 B（架构/生命周期/并发/假绿面）**：B1=与 A2 合并。B2 deleted 组合语义 → 与 A10
合并（删除优先——比「先应用再删」简单且无中间态）。B3=与 A5 合并。B4 structuredClone
throw 无降级 → **采纳**：invalid-args:metadata not cloneable（§1.4/§6）。B5 无并发
interleaving 用例 → **采纳**：并发组三用例（§6）。B6 无 session 零覆盖 → **采纳**：
dispatch 直连用例（§6；并注明与件14 拒无 session 口径有意相反的理由 §1.3）。
B7 双向冗余存储撕裂面 → **采纳**：单源边集、出口派生（§1.4）。B8 Metadata 铸文
BigInt throw → **采纳**：`<unserializable>` 降级（§1.5）。B9 apply 中途 throw 回卷
断言缺失 → **采纳**（§6）。B10 dispose 后负向边界 → **采纳**：unknown-tool +
not provided 双断言（§6）。B11 update subject 空串未定义 → **采纳**：同 create 拒
（§1.1）。B12=与 A6 合并。B13 e2e 断言面薄 → **采纳**：落账数量 + 铸文锚 + deleted
收尾（§6）。B14 per-param 全量对账 → 与 A3 合并（全量而非取样）。B15=与 A9 合并。

**核过无偏（两路一致）**：参数面与规格逐项一致、required 面解读、status set 语义、
deleted/清边/id 不复用、metadata 键级合并、依赖追加去重与双向语义、共享清单裁决、
并发档 parallel 论据、inject 接线与 effect 摘除、依赖方向无环、dispose 顺序、
additionalProperties 裁决依据核实、e2e 装置可行性。

## 10. 收口前对抗审查处置（两路并行，14 项全处置）

**路 A（契约/语义对照面）**：P1-1 对账测试绑死单机绝对路径 → **采纳根治**：spec 快照
入仓 fixtures（不沿袭 agent-delegation contract.test 机器绑定债——门禁可移植性优先）。
P2-1 并发 update 杂交断言锁不住（字段级交错仍绿——审查者脚本复证）→ **采纳**：同源
断言（subject/owner 轮次后缀一致）。P2-2 方案 §1.4 与实现校验位置漂移未同变 →
**采纳**：§1.4 重写（语义校验与最小形状防御单点住 store）+ store 头注释同变。
P3-1 get 复用 TodoCreateResult 名 → **采纳**：改名 TodoTaskResult。P3-2 两处不可达
死分支（`?? "undefined"` / `?? "invalid request"`）→ **采纳**：清理 + TodoReject.message
改必填（所有 reject 调用本就必带）。P3-3 create 回执硬编码 status: pending →
**采纳**：取快照值。

**路 B（并发/生命周期/假绿面）**：P1-1=与 A-P2-1 合并（同源断言）。P1-2 enum 对账
缺位 + required 面硬编码自证 → **采纳**：表格类型列/必填列解析对账（status enum ↔
Union literals 双向；create 特例按规格注记 required 空——表格 ✅ 与注记矛盾以注记
为准，方案 §1.1 既有裁决）。P2-3 反向清边零单测（removeRow 反向摘除分支 0 覆盖）
→ **采纳**：补「删被阻塞任务后 blocker blocks 为空」用例。P2-4 卡片 Description 行
零断言 → **采纳**：纯函数直测补形态。P2-5 squatter 用例恒真断言（throw 前未注册的
工具断言 undefined）+ 探针缺失 → **采纳**：squatter 占名第 3 个工具（task_list），
断言 throw 前已注册的 task_create/task_get 被回卷摘除。P3-6 dispose 注释无断言
支撑 → **采纳**：删误导注释。P3-7=与 A-P1-1 合并。P3-8=与 A-P3-1 合并。P3-9 store
头注释与实现矛盾 → 与 A-P2-2 合并同变。P3-10 e2e 收轮断言依赖 events.at(-1) →
**采纳**：改 filter turn/end 终态事件。P3-11 inject 用例 toThrow 无模式 → **采纳**：
加 /tools/ 模式。

**收口审查连带发现（core 存量缺陷，当场修）**：P2-5 处置中暴露 loadPlugins 对
apply 中途 throw 的插件**自身已捕获注册不回卷**（composite 尚未入层账本即 throw——
captureRegistrations 的「统一兜底回卷」设计意图在 throw 路径漏挂账，半装状态泄漏；
本件 plugin.ts 注释声称的「apply 中途 throw 也回卷」在 core 现实现下不成立）→
**core/load-plugins.ts catch 路径补逆序回卷 + core 回归用例**（「half」插件两 effect
逆序 unwind 断言）；task-tools 等既有插件注释的同款表述随 core 修复成真。

## 11. 收口数字（2026-09-19）

- 四门：lint（todo-tools + core + e2e 旅程面）0-0 / tsc 0 / build ok / test 全绿；
  全仓 lint 余 1 错 3 警位于 packages/e2e/gap-probe.ts 与 real.ts——**他人基线**
  （602063e 引入，不在本件提交范围，不越界代修）。
- 用例：todo-tools 45（store 23 + tools 14 + plugin 4 + descriptions 4）+ core 回归 1；
  全仓 1237 例全绿；e2e 十一场景（含 todo 八步旅程）绿。
- 覆盖率：todo-tools lines/branch/funcs/stmts 全 100（阈值 90/85/90/90）；
  全仓 lines 94.09 / branch 90.69 / funcs 94.16 / stmts 96.46。
- 已知覆盖盲区：无（收口审查指出的 removeRow 反向分支与 Description 行已补用例盖绿）。

## 12. 修订A：清单持久化（已撤销——由 §13 修订B 取代）

> **撤销（2026-09-19 用户裁决，未实施零清理）**：快照文件方案是「不动共享本体前提下的
> 局部最优」。对照 DSH（deepseek-harness tool-todo）后认定件15 §1.3 的「装配级共享」
> 裁决本身是对规格的过度推广——Claude Code 的 taskId 会话内从 1 计数、清单语义
> "current coding session"，规格 §8 的 owner 协作是 teammate 部署形态且本仓无消费方
> （子代理协作走 agent-delegation spawn prompt）。归属修正为 per-session 后，持久化
> 从「自建快照文件」消解为「会话事件流免费继承」。本节保留为决策痕迹，全部条款由
> §13 取代；§1.3/§5/§7 的共享口径同步由 §13 修订。

### 12.1 形态裁决

- **快照 = 装配级单文件**：`createTodoToolsPlugin({ snapshotPath })` 指定路径（推荐
  放档案 root 下，如 `<root>/todo-snapshot.json`）；清单是装配级共享实体（§1.3），
  快照同为装配级——不挂任何会话名下（A 会话建的任务 B 会话 resume 后同样可见，
  共享语义跨重启存续）；
- **每变更原子全量写**（temp + rename，tool-write 同款原子纪律）：store 变更成功后
  同步回调 sink 落盘。对比挂件6 checkpoint 屏障（副作用前 flush）的取舍：每变更即写
  **无尾巴窗口**（屏障形态在「变更后到下一边界间崩溃」丢一拍）、件6 零改动、
  store 仍全同步无 await——**并发档 parallel 论据原样保持**（同步内存 + 同步写盘，
  无竞态窗口）；清单量级（协作 todo，几十条）全量 JSON 写放大可忽略；
- **恢复时机 = 装配 apply 期自动**：文件不存在 = 全新清单（正常态）；存在即读入
  灌 store。快照损坏（非法 JSON/形状门不过）→ **装配期 throw fail-closed**（静默
  空清单 = 任务全丢装作没事；对齐 jsonl 档案 corrupt → dead 口径）；
- **seq 随快照持久**：id 不复用语义跨重启保持（恢复后新建任务从快照 seq 续号，
  不与既有 id 相撞）；
- **无 snapshotPath = 易失形态**（既有行为）：不是兼容层，是「有/无持久化层」的两种
  合法装配形态（同 session 有/无 jsonl 持久化先例——空屏障语义）。

### 12.2 快照格式（闭合形状门，无版本字段——SESSION-RESUME §1.2 先例）

```ts
interface TodoSnapshot {
  readonly seq: number;                          // id 计数器（≥ 所有任务 id 数值）
  readonly tasks: readonly TodoSnapshotTask[];   // 无依赖字段（依赖在 edges 单源）
  readonly edges: readonly (readonly [blocker, blocked])[];  // 依赖边对（blocksOf 展平）
}
```

形状门（读取即校验，住 persistence 层）：JSON 可解析；tasks 数组且 id 唯一、十进制
数字串 ≥1；status ∈ 三值闭合词表（无 deleted——物理移除不进快照）；subject 非空串；
metadata 为对象或缺席；edges 二元组且引用的 id 全部在场；seq ≥ max(id)。非法 →
throw（带路径与违反项）。语义级变更发生时再引入显式判别字段——字段缺席即旧快照。

### 12.3 拆分

```text
packages/todo-tools/src/persistence.ts   # 快照文件读写：原子写（temp+rename）+ 形状门 load
packages/todo-tools/src/store.ts         # 构造参数 { initial?: TodoSnapshot; onCommit?: (s: TodoSnapshot) => void }
                                          #   ——变更成功后同步回调 onCommit；snapshot() 内部态导出
packages/todo-tools/src/plugin.ts        # 工厂参数 { snapshotPath?: string }；apply 期 load 灌入 + sink 挂 store
packages/todo-tools/src/__test__/persistence.test.ts
packages/e2e/src/todo-journey.ts         # 旅程段：变更→dispose→新装配同 snapshotPath→清单在场 + seq 续号
```

### 12.4 测试口径

- **往返全等**：多任务 + 依赖边 + metadata + owner 各形态 → snapshot() → 新 store
  initial 灌入 → list/get/snapshot 逐字段全等（含依赖双侧派生）；
- **原子性**：写后无 temp 残留；写到一半崩溃形态（手工截断文件）→ load fail-closed；
- **形状门表驱动**：非法 JSON / tasks 非数组 / id 重复 / id 非数字串 / status 出表 /
  subject 空串 / edges 引用悬空 / seq < max(id) / seq 负数——逐项 throw 带违反项；
- **id 续号**：删任务 1 后 dispose → 新装配恢复 → 新建任务 id = seq+1 不撞既有；
- **每变更即写**：create/update（含 deleted）后文件即时反映（无 flush 依赖）；
- **易失形态回归**：无 snapshotPath 装配行为与本件 A 阶段一致（dispose 后无副作用）；
- **plugin 装配**：snapshotPath 在场时 apply 恢复 + 变更落盘；快照损坏装配期 throw；
- **e2e**：旅程段「变更→dispose→新装配→清单与 seq 回来」经真实装配。

### 12.5 不处理（落档）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| todo 变更进 session 事件流（第 15 词条） | 清单是装配级实体，挂会话档错位；session 词表闭合（件5 收口）不动 | 本修订裁定 |
| 快照写盘挂件6 checkpoint 屏障 | 尾巴窗口弱于每变更即写；件6 零改动 | 本修订裁定 |
| 多装配同 snapshotPath 并发写 | 单进程单写者是 jsonl 同款硬性前提（SESSION-RESUME §1.4） | 部署纪律 |
| 快照压缩/增量 | 量级微不足道 | 不建 |
| 跨 root 迁移/合并 | 无场景 | 不建 |

## 13. 修订B：per-session 清单 + 事件流持久化（2026-09-19 用户裁决「开始执行」）

> 状态：**定稿**（两路定稿前审查 27 项全处置，见 §13.6）。级别：中（todo-tools 归属
> 契约改造 + session 词表第 16 词条 + e2e resume 段）。
> 取代 §12（撤销记录见彼）；上游参考 deepseek-harness `packages/todo/tool-todo`（事件流
> 持久化 + last-wins fold 思想；其 turn/start 清零与单工具整表面**不采纳**——本仓保留
> 四动词规格对齐与「任务到 completed/deleted 为止」的生命周期）。

### 13.1 形态裁决

- **清单归属：每会话一份**（会话键控桶——BackgroundTasks/ObservedRegistry 同款先例；
  `ctx.session ?? "_anon"`：无 session 调用方**共享一个匿名桶**（先例同口径——`_anon`
  非合法 SessionId，首字符禁 `_`，与真实会话 id 空间不相交）。id 会话内从 1 计数
> （回到规格示例原样）；依赖/owner 字段照存（规格对齐面零改动——owner 的跨代理协作
> 在单会话内是虚指，张力补进 §2③ 落档）；**跨会话隔离**（§1.3 共享裁决撤销：该语义
> 无生产消费方——grep 证实 todoList 零外部引用，损失仅在测试/e2e 断言面，见 §13.4）；
- **持久化：每次变更后全量快照 append 为 log-only 事件 `todo/snapshot`** 进发起会话
  档案（append 同步入内存卷 + jsonl pending drain；append-only + checkpoint 屏障 +
  尾态修复全部继承档案层）。**execute 体内自惰性恢复起至 append 停是单一同步段**
  （禁止任何 await/异步读档——恢复只读 `sessionStore.get(id).events()` 同步内存卷；
  async 函数体无 await 即 run-to-completion，并发调用的变更→append 入队序 == 变更序，
  last-wins 恒正确）。工具面读动词触达只 fold **不补写快照**（否则首触达多写一拍）；
- **服务面 = 内存真相，恒不 append**：append 单点住工具面 execute（宿主经 todoList
  服务变更后档案暂失步，下次工具变更的全量快照覆盖自愈——同 §13.1 自愈口径）；
- **恢复：惰性 fold**——某会话的桶首次被触达时（四动词任一 execute），从该会话内存
  事件卷折尾取最后一条 `todo/snapshot` 灌桶（**深拷贝重建可变副本**——卷内事件 data
  是 deepFreeze 产物，直接引用灌桶则恢复后 update 变异 row 严格模式 throw）；
  **桶在场即不再 fold**（后续内存变更不被卷尾快照覆盖）。resume 后 seed 事件卷在内存
  日志，首次调用即恢复；fork 的 seed 前缀含快照 → fork 会话继承源清单至切口副本
> （自然语义，落档）。空卷/无快照事件 = 全新桶；匿名桶永不恢复；
- **桶生命周期 = 会话**：`sessionDisposed` 逐出桶（observed/BackgroundTasks 同款挂法）。
  逐出后同 id 重建：**无 seed create = 空卷全新桶；resume（seed 前缀）= 恢复旧清单**
> ——由 seed 有无自然区分，不矛盾；
- **会话缺席 fail-closed（四动词统一）**：带 session 但 `sessionStore.get(id)` 缺席
  （宿主伪造/已 dispose）→ isError；无 session（匿名桶）合法易失，不 append 不恢复；
- **append 失败（Result !ok）语义**：工具回 isError 且**内存桶保留已生效变更**——
  回执明写「已生效未持久化」（防模型误以为失败而盲目重试 create 造成重复任务）；
  reason 分两类：**确定性**（not-json-safe——桶内残留不可 JSON 序列化值如 BigInt
  metadata：全量快照每条都含它，append 持续失败，**自愈条件 = 该值被 update 覆盖或
  任务删除后**；期间档案停在坏数据入库前，崩溃恢复会丢该段变更且 seq 回退、重建 id
  与已展示 id 可能撞号——如实落档）与**瞬时**（I/O 类，重试可期）。

### 13.2 第 16 词条 `todo/snapshot`（session 词表追加式演进——SESSION-RESUME §1.2 明文支持；现词表 15 条，types/gates 头注释「15 条」同步改 16）

```ts
// session/src/types.ts（词条 data 类型住 session——inbox 词条同款先例；log-only）
export interface TodoSnapshotTaskData {
  readonly id: string;                                  // /^[1-9][0-9]*$/（拒 "01"——数值同序字面不等会破 byNumericId 稳定性与唯一门）
  readonly subject: string;                             // 非空
  readonly status: "pending" | "in_progress" | "completed";
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface TodoSnapshotEventData {
  readonly seq: number;                                 // count；空 tasks 时约定 max 取 0
  readonly tasks: readonly TodoSnapshotTaskData[];
  readonly edges: readonly (readonly [blocker: string, blocked: string])[];  // 单源边集展平（Map<String,Set> 展平无损）
}
readonly "todo/snapshot": TodoSnapshotEventData;        // SessionEventData 第 16 词条
```

gates 词条门：seq count；tasks 数组逐项（id 匹配规范形且唯一、subject 非空串、status
三值闭合、description/activeForm/owner 缺省或串、metadata 缺省或对象）；edges 二元组、
**blocker ≠ blocked（自环——工具面 checkReferences 拒的态，门也拒）**、两端 id 全部
在场；seq ≥ max(id 数值)（空集取 0）。档案手工重复边过门、恢复灌 Set 去重（非 store
可达态，无害——落档）。**不设 turn 开放性门**（DSH invariant 的「open turn 内」不采纳：
直连带 session 可在无 turn 卷内 append，log-only 无 surface 后果——落档）。

### 13.3 拆分

```text
packages/core/session/src/types.ts     # TodoSnapshotTaskData/TodoSnapshotEventData + 词条 + 头注释 16
packages/core/session/src/gates.ts     # 形状门 validator + 词表计数注释
packages/todo-tools/src/tokens.ts # 服务签名加 session 参数（SessionId | undefined 首参）；
                                  #   快照类型复用 session 词条类型（单一真相）
packages/todo-tools/src/store.ts  # 会话键控桶 + snapshotOf/restoreOf（深拷贝）+ seq 桶内计数
packages/todo-tools/src/plugin.ts # inject ["tools","session"]（硬依赖——todo 价值=随会话，
                                  #   无 session 装配不可用：装配面收窄落档）；sessionDisposed 逐出
packages/todo-tools/src/tools.ts  # execute 单一同步段：惰性恢复 → 变更 →（带 session）append
packages/e2e/src/todo-journey.ts  # resume 段：dispose → 新装配同 root → resume → followup
                                  #   触发 todo 工具 → 清单/依赖/seq 在场；既有 anon 断言反转
```

依赖方向：todo-tools → core/tools/session（新增 session；无环）。

### 13.4 测试口径

- **隔离反转**：跨 session 互见用例反转为隔离断言（A 建的 B 不可见、id 各自从 1）；
  匿名桶（共享单桶）独立可用；**服务面全部既有用例加会话实参（或匿名缺省）**——
  签名变化波及 store.test/plugin.test/e2e 的全部 `todoList` 断言（非零改动，如实计）；
- **append 语义**：带 session 变更后卷含 `todo/snapshot`（last-wins 与桶终态全等）；
  **经 dispatch 并发**（不直连 store——直连测不到 execute 同步段）两路并发变更 →
  卷内快照序列单调包含（create×2 两条快照分别恰含 {id1} 与 {id1,id2}）；
  **并发首触达**（桶不存在，Promise.all 两路 dispatch）→ 单 fold 无双灌；
  读动词触达不补写快照（卷内快照数不变）；
- **append 失败**：metadata 含 BigInt（服务面入库）→ isError 铸文含「已生效未持久化」
  与确定性指引 → **覆盖该 metadata / 删该任务后** append 恢复成功（自愈条件用例）；
  带 session 但会话缺席 → isError（读动词同口径）；dispose 后 dispatch 带 session →
  isError 而非孤儿桶静默变更；
- **惰性恢复**：预置事件卷（多条快照）→ 首次 get/list → last-wins 灌桶（依赖边双向
  派生恢复）；**恢复 → 变更 → 再触发动词 → 桶不被卷尾快照覆盖**（桶在场不再 fold
  ——真不变量）；恢复后 update 可变更（深拷贝副本，非冻结引用 throw）；空卷 → 全新桶；
  匿名桶不恢复；恢复幂等（同卷 fold 结果全等）；
- **桶逐出**：sessionDisposed 后同 id 重建会话 → 新桶（**裸 session 装配下测**——
  jsonl 装配同 id 重建 header 不等撞 session-id-reused permanent dead）；
- **session gates**：todo/snapshot 表驱动（合法 / seq 负 / id 非规范形含 "01" 与 "0" /
  id 重复 / status 出表 / subject 空 / edges 悬空 / edges 自环 / seq < max id / 空
  tasks 合法 / 重复边过门去重）；
- **多桶并发**：两会话并发变更互不干扰 + 各卷尾正确；覆盖率只升不降（现 100）；
- **回归**：四动词契约面（参数/铸文/语义）零改动——descriptions/对账用例原样；
- **e2e**：八步旅程改造——任务 2 的删除保留但**留一条带依赖的存活任务到 resume 后**
> （否则依赖边恢复无 e2e 覆盖）；anon 直连断言反转为 `No tasks`（匿名桶空）；resume
  段（dispose 前置 flush → 新装配同 root → create({header, seed}) → followup 脚本
  task_list → 断言清单在场/依赖/seq 续号）——装置嫁接 agent-journey 崩溃残卷段形态。

### 13.5 不处理（落档）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 跨会话共享/owner 协作 | §1.3 裁决撤销（无生产消费方）；规格 §8 teammate 形态是部署语义 | 本修订裁定 |
| turn/start 清零（DSH 语义） | 清单生命周期到 completed/deleted 为止（规格语义）；DSH 的 turn 级计划是另一种本体 | 本修订裁定 |
| todo/write 单工具整表面 | 四动词是件15 用户指令的规格对齐面；操作审计由 tool/call 事件承担，档案面仍是 DSH 同构 last-wins 整表快照 | 件15 既有裁决 |
| 持久化强度相对修订A 回退（屏障窗口：末变更后到下一 checkpoint 屏障间崩溃丢该拍，resume 回退到上一快照） | 归属修正的代价——修订A 的「每变更即写无窗口」依附独立文件形态，随 §12 撤销一并放弃；checkpoint 屏障频率（每请求/每工具）已很密 | 本修订裁定（取舍痕迹） |
| 无 session 装配（sessionStore 硬依赖缺席） | todo 价值 = 随会话；inject ["session"] 缺席装配期 throw | 本修订裁定（装配面收窄） |
| 非 agent 宿主直调的持久化 | 匿名桶易失（无档案归属）——合法装配形态 | 本修订裁定 |
| turn 开放性门（DSH invariant 的 open-turn 约束） | log-only 无 surface 后果；直连形态合法 | 本修订裁定 |
| 快照事件压缩/滑窗 | 量级微不足道；档案滑窗归策略插件 | 后续件 |
| 多装配同 root 并发 | 单进程单写者（SESSION-RESUME §1.4 同款硬性前提） | 部署纪律 |

### 13.6 定稿前对抗审查处置（两路并行，27 项全处置）

**路 A（契约/语义）**：P1-1 BigInt 自愈论断错误（确定性失败非瞬时——档案停在坏数据前、
seq 回退撞号）→ **采纳**：§13.1 自愈条件改「坏值被覆盖/删除后」+ 撞号如实落档。
P1-2 isError 回执语义缺失（模型认知与桶状态发散）→ **采纳**：「已生效未持久化」+
确定性/瞬时分因。P2-3 门缺自环 → **采纳**（§13.2）。P2-4 id 规范形 "01" → **采纳**
（正则拒）。P2-5 e2e anon 断言反转未点名 → **采纳**（§13.4 点名）。P2-6 「新会话新卷」
与 resume 矛盾 → **采纳**：seed 有无自然区分（§13.1）。P2-7 「既有用例全保持」不准 →
**采纳**：服务面用例统一加会话实参（§13.4）。P2-8 恢复幂等钉不住真不变量 → **采纳**：
改「桶在场不再 fold」用例。P3-9/14 计数与门边界（空集 max=0、重复边去重落档）→
**采纳**。P3-10/11/12 fork 继承/turn 门不设/owner 张力 → **采纳落档**。P3-13 匿名桶
措辞 → **采纳**（共享单桶，§13.1）。

**路 B（并发/生命周期/假绿）**：P1-1 zero-await 未覆盖恢复段（fold 被写成 async 则
并发首触达双灌桶）→ **采纳**：单一同步段明文 + 并发首触达用例（§13.1/§13.4）。
P1-2 = 与 A-P1-1 合并。P1-3 读动词会话缺席口径缺失 → **采纳**：四动词统一 fail-closed
（§13.1）。P2-1 服务面 append 语义空白 → **裁决**：服务面 = 内存真相恒不 append，单点
住工具面（§13.1）。P2-2 并发组断言弱/未钉通道 → **采纳**：经 dispatch + 单调包含
断言（§13.4）。P2-3 dispose 负向 + 铸文锚 → **采纳**（§13.4）。P2-4 桶逐出用例装配
形态（jsonl 同 id 重建撞 dead）→ **采纳**：裸 session 装配（§13.4）。P2-5 恢复灌桶
须重建可变副本（deepFreeze 卷）→ **采纳**（§13.1/§13.4）。P2-6 持久化强度回退未留痕 →
**采纳落档**（§13.5）。P2-7 inject 收窄未落档 → **采纳落档**（§13.3/§13.5）。
P2-8 e2e 依赖恢复零覆盖 → **采纳**：留带依赖存活任务（§13.4）。P3-1 计数 → 与 A 合并。
P3-2 恢复不补写 → **采纳落档**（§13.1）。P3-3 fork → 与 A 合并。P3-4 e2e anon 点名 →
与 A 合并。P3-5 `_anon` 空间不相交依据（isSafeSessionId 首字符禁 `_`）→ **采纳**：
写进 §13.1 依据。P3-6 多桶并发/覆盖率 → **采纳**（§13.4）。

**核过无偏（两路一致）**：归属自洽（依赖/owner 会话内闭合）、惰性恢复无缺尾窗口
（events() 同步内存卷）、append 同步性与 run-to-completion 论据、dispatch 双前置
await 不破坏段内原子、dispose 与 in-flight 无错序窗口、jsonl per-id 串行、checkpoint
兼容、surface/repair/resume 无冲突（log-only 不进投影）、data 形态完备（边集展平
无损）、`_anon` 无撞桶、DSH 取舍如实、依赖方向无环、e2e resume 装置可行、旧档案
自然兼容（词表子集）。

## 14. 修订B 收口审查处置（两路并行，17 项全处置）与收口数字

**路 A（契约/语义）**：P1-1 覆盖率回退（99.21<100）→ **采纳根治**：快照往返全字段矩阵
（含 activeForm/多 blocker 边排序/update 路径恢复入口）——**回到 100/100/100/100**。
P1-2 包出口头注释与实现相反 → **采纳**（index.ts/descriptions.ts 改 §13 口径）。
P1-3 TODO.md 多节未同变 → **采纳**：§0/§1.3/§5/§6 加撤销指针（注记式取代，正文留决策
痕迹）。P1-4 SESSION.md 词表三处未同变 → **采纳**：标题 16 + log-only 清单 + 表格补
todo/snapshot 行。P2-5 多桶并发用例缺失 → **采纳**（两会话并发 + 各卷尾 last-wins）。
P2-6 evict 用例名实不符 → **采纳**（正向逐出断言：id 从 1 重计）。P2-7/8/9 tools.test
头注释/组名、gates.test「16 词条」、descriptions 张力注记 → **采纳**。P3-10 缺席漏
update → **采纳**。P3-11 自愈只测覆盖 → **采纳**（删任务自愈变体）。P3-12 events 全卷
拷贝 → 与 B 合并（thunk 化）。P3-13 id > 2^53 精度边界 → **落档 §13.5**（工具面自产
不可达——seq 单调计数不会超安全整数；仅伪造档案面，DSH 同款接受面）。P3-14 并发首触达
区分力弱 → **采纳**（卷置两条快照，取尾不取首可观测）。

**路 B（并发/生命周期/假绿）**：P1-1 **服务面读探测创建空桶、劫持工具面惰性恢复**
（真 bug：宿主 get/list 探测后该会话 agent 的 task_list 永远 No tasks、恢复失效）→
**采纳根治**：bucketFor 拆 peek（读路径零创建副作用）/ensure（写路径）；restore 的
桶在场判定先行（thunk 取卷——顺带根治 P2-3 白拷贝）；补「服务面读探测 → 工具面恢复
仍生效」回归锚。P2-1 并发单调包含钉不死 append 同步性 → **采纳**：tool.execute 不
await 立即断言卷已含快照（延迟 append 形态必挂的直钉用例）。P2-2 restore 幂等恒真 →
**采纳**：改「逐出后同卷重 fold 全等」真形态。P2-3/P2-4 → 与 A 合并。P3-1=与 A-P3-10
合并。P3-2=与 A-P2-6 合并。P3-3 多桶隔离名含依赖零操作 → **采纳**（跨桶引用
invalid-args 断言）。P3-4=与 A-P2-8 合并。P3-5 activeForm 往返 → 与 A-P1-1 合并。
P3-6 e2e resume 后持久化继续工作 → **采纳**（rc-2 新快照含 id 3 落卷断言）。

**收口数字（2026-09-19）**：四门 lint（本件范围）0-0 / tsc 0 / build ok / test
**1261 例全绿**（todo-tools 67：store 32 + tools 26 + plugin 5 + descriptions 4）；
todo-tools 覆盖率 **100/100/100/100**；全仓 94.12/90.82/94.21/96.52；e2e 十一场景
（含 todo 旅程 resume 段）全绿。全仓 lint 余 1 错 3 警属 real.ts/gap-probe.ts（他人
基线，不越界代修）。


## 16. 控制类工具身份（2026-09-19 用户裁决「修复启示3」——对齐 Codex is_builtin_control_tool）

**问题**：permission 的 decideFor 对名单外工具回 `ask`（`unknown tool:xxx`）——todo 四工具
在 permission 装配下进审批，broker 缺席时 fail-closed 拒绝——agent 记待办的自我组织行为
被安全面拦截。

**方案（小级）**：`ToolDefinition.isControlTool?: true`（声明权在工具定义——agent 自我
组织/控制面行为、非环境副作用；permission 只认标记不认名单，未知工具 ask 兜底保持）；
dispatch 的 preExecute 载荷填充 `control: true`；decideFor 首行直通
（`resolvedBy: "control-tool"`）；todo 四工具声明。安全模型：标记由装配方信任的工具自带
（与 Codex 内置工具同权），不放宽未声明工具的裁决。
