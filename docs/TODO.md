# TODO：任务清单件（件 15）

> 状态：**定稿**（两路定稿前对抗审查 19 项全处置，见 §9）
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

不做（落档 §7）：持久化/resume 恢复、环检测、UI 观察面/事件总线、会话隔离、条目数帽。

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

### 1.3 清单边界（与件14 后台任务的本质差异）

- **共享清单**（装配内单例，非会话键控）：规格 §8 多代理协作语义——owner 认领、
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
- **服务面信任边界**：类型即契约——运行时形状守卫仅在工具面（校验层 + 前置校验）；
  宿主绕过 TypeScript 传垃圾 = 宿主 bug，服务面不防（cloneable 守卫是唯一例外，
  因其崩溃而非类型问题）；
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
schema 有的参数描述必提——件14 descriptions.test 先例）。

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

## 5. 裁决

- **用户裁决**：参数与提示词对齐规格（原始指令「参数和提示词一样就好」；工具名
  引用改写与张力提法保留是「对齐本仓实名/逐字」的推论，见 §2）。
- 默认裁决（否决窗口内可推翻）：
  - 工具名小写蛇形 `task_create` 族（规格 TaskCreate 家族命名 + 本仓 bash/read/write
    小写化先例——模型侧家族性与仓内命名规约同时成立）；
  - 共享清单非会话键控（规格 §8 协作语义——见 §1.3 论据）；
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
- **共享语义锚**：两个不同 session 的调用方互相可见对方创建的任务；
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

- [ ] §1 契约逐条（四工具参数面 == 规格表、铸文、并发档、服务面）
- [ ] §6 测试口径逐条落地全绿
- [ ] 四门 + 覆盖率数字如实报告；e2e 旅程绿
- [ ] 对抗审查（定稿前 + 收口前各 ≥2 路）问题清零

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
