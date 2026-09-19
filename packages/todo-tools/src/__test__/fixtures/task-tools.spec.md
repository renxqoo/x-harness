# Claude Code Task 工具文档

> 整理自 2026-09-19 会话的实际工具定义（JSON Schema）。
> 共 6 个名字带 Task 的工具：4 个是任务清单（todo）工具，2 个是后台任务管理工具。

## 工具总览

| 工具 | 类别 | 用途 | 参数 |
|---|---|---|---|
| TaskCreate | 任务清单 | 创建新任务（初始为 `pending`） | subject（必填）、description、activeForm、metadata |
| TaskGet | 任务清单 | 按 ID 读取单个任务完整详情 | taskId（必填） |
| TaskList | 任务清单 | 列出全部任务及阻塞关系 | 无 |
| TaskUpdate | 任务清单 | 更新状态/字段/依赖/认领人 | taskId（必填）+ 8 个可选字段 |


---

## 1. TaskCreate — 创建任务

### 参数

| 参数 | 类型 | 必填 | Schema 中的 description |
|---|---|---|---|
| `subject` | string | ✅ | A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow") |
| `description` | string | — | What needs to be done |
| `activeForm` | string | — | Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug"). If omitted, shows the subject instead |
| `metadata` | object | — | Arbitrary metadata to attach to the task |

- Schema 约束：`additionalProperties: false`，四个参数全部为可选（required 数组为空），但语义上 subject 必填。
- 返回值：新任务的 ID，状态一律为 `pending`。

### 完整原始 description（英文原文）

> Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
>
> It also helps the user understand the progress of the task and overall progress on their requests.
>
> ## When to Use
>
> Use this tool proactively in these scenarios
>
> - Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
> - Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
> - Plan mode - When using plan mode, create a task list to track the planned work
> - User explicitly requests todo list - When the user directly asks you to use the todo list
> - User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
> - After receiving new instructions - Immediately capture user requirements as tasks
> - When you start working on a task - Mark it as in_progress BEFORE beginning work
> - After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation
>
> ## When NOT to Use
>
> Skip using this tool when:
>
> - There is only a single, straightforward task
> - The task is trivial and tracking it provides no organizational benefit
> - The task can be completed in less than 3 trivial steps
> - The task is purely conversational or informational
>
> NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.
>
> ## Tips
>
> - Create tasks with clear, specific subjects that describe the outcome
> - After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
> - Check TaskList first to avoid creating duplicate tasks

### 中文摘要

创建结构化任务清单，用于跟踪进度、组织复杂任务、向用户展示完成度。
**该用**：≥3 步的复杂任务、需谨慎规划的任务、规划模式、用户主动要 todo、用户一次给了多个任务、收到新指令时立刻记录、开工前标 in_progress、完成后标 completed 并补充实施中新发现的后续任务。
**不该用**：单一简单任务、琐碎到没有组织价值的任务、少于 3 个琐碎步骤的任务、纯对话/咨询类任务。只有一件小事时直接做，别建清单。
**技巧**：标题要清晰具体、描述结果；建完用 TaskUpdate 设置依赖（blocks/blockedBy）；先 TaskList 防止建重复任务。

---

## 2. TaskGet — 读取单个任务

### 参数

| 参数 | 类型 | 必填 | Schema 中的 description |
|---|---|---|---|
| `taskId` | string | ✅ | The ID of the task to retrieve |

### 完整原始 description（英文原文）

> Use this tool to retrieve a task by its ID from the task list.
>
> ## When to Use
>
> - When you need the full description and context before starting work on a task
> - To understand task dependencies (what it blocks, what blocks it)
> - After being assigned a task, to get complete requirements

### 中文摘要

开工前读取任务的完整描述与上下文；弄清依赖关系（它阻塞谁、被谁阻塞）；被分配任务后获取完整需求。TaskUpdate 的 Tips 里特别强调：**更新前先 TaskGet 读最新状态**。

---

## 3. TaskList — 列出全部任务

### 参数

**无参数**（Schema 为空对象，`additionalProperties: false`）。

### 完整原始 description（英文原文）

> Use this tool to list all tasks in the task list.
>
> ## When to Use
>
> - To see what tasks are available to work on (status: 'pending', no owner, not blocked)
> - To check overall progress on the project
> - To find tasks that are blocked and need dependencies resolved
> - After completing a task, to check for newly unblocked work or claim the next available task
>
> Prefer working on tasks in ID order (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

### 中文摘要

查看可做的任务（`pending`、无 owner、未被阻塞）、检查项目整体进度、找出被阻塞的任务、完成一项后看哪些任务被解除阻塞并认领下一个。多个任务可用时**优先按 ID 从小到大做**——早的任务常为晚的任务铺垫上下文。

---

## 4. TaskUpdate — 更新任务

### 参数

| 参数 | 类型 | 必填 | Schema 中的 description |
|---|---|---|---|
| `taskId` | string | ✅ | The ID of the task to update |
| `subject` | string | — | New title for the task (imperative form, e.g., "Run tests") |
| `description` | string | — | New description for the task |
| `activeForm` | string | — | Present continuous form shown in spinner when in_progress (e.g., "Running tests") |
| `status` | enum: `pending` \| `in_progress` \| `completed` \| `deleted` | — | New status for the task |
| `owner` | string | — | New owner for the task (agent name) |
| `metadata` | object | — | Merge metadata keys into the task (set a key to null to delete it) |
| `addBlocks` | string[] | — | Task IDs that this task blocks |
| `addBlockedBy` | string[] | — | Task IDs that block this task |

- Schema 约束：`additionalProperties: false`。
- `metadata` 是**合并式**更新：同名键覆盖，设为 `null` 删除该键。

### 完整原始 description（英文原文）

> Use this tool to update a task in the task list.
>
> ## When to Use
>
> - Mark tasks as resolved:
>   When you have completed the work described in a task
> - When a task is no longer needed or has been superseded
> - Setting status to 'deleted' permanently removes the task
> - Update task details:
>   When requirements change or become clearer
>   When establishing dependencies between tasks
>
> ## Status Workflow
>
> Status progresses: `pending` → `in_progress` → `completed`
>
> Use `deleted` to permanently remove a task
>
> ## Tips
>
> - Make sure to read a task's latest state using TaskGet before updating it
> - Mark task as in progress when starting work:
>   `{"taskId": "1", "status": "in_progress"}`
> - Mark task as completed after finishing work:
>   `{"taskId": "1", "status": "completed"}`
> - Delete a task:
>   `{"taskId": "1", "status": "deleted"}`
> - Claim a task by setting owner:
>   `{"taskId": "1", "owner": "my-name"}`
> - Set up task dependencies:
>   `{"taskId": "2", "addBlockedBy": ["1"]}`

### 中文摘要

状态单向流转：`pending` → `in_progress` → `completed`；`deleted` 是永久删除。需求变化或要建立依赖时更新任务字段。技巧：更新前先 TaskGet 读最新状态；开工标 in_progress、完工标 completed、废弃标 deleted；用 `owner` 认领任务；用 `addBlockedBy` 声明"任务 2 被任务 1 阻塞"。

---



## 7. 系统提示词中是否有提及这些工具？

**结论：系统提示词正文完全没有提及 Task 系列工具的任何参数或用法。**

具体说明：


## 8. 典型工作流

```text
TaskCreate("Fix login bug")        → 返回 taskId=1，状态 pending
TaskCreate("Add regression test")  → 返回 taskId=2，状态 pending
TaskUpdate(taskId=2, addBlockedBy=["1"])   # 2 被 1 阻塞
TaskUpdate(taskId=1, status="in_progress") # 开工
... 修复完毕 ...
TaskUpdate(taskId=1, status="completed")   # 完工
TaskList()                                  # 发现 2 已解除阻塞
TaskUpdate(taskId=2, status="in_progress") # 继续下一项
```

多代理协作时用 `owner` 认领（如 `TaskUpdate(taskId=1, owner="worker")`），各代理通过 TaskList 领取无主、未阻塞的 `pending` 任务，并按 ID 从小到大优先处理。
