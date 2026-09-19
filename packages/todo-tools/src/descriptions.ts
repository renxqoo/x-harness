// 工具 description（docs/TODO.md §2）：正文取 Claude Code 规格原文（源
// /Users/wrr/work/claude-tool/task-tools.md），偏离按类别落档件15：
// ① 描述内工具名引用改写为本仓实名（TaskUpdate→task_update、TaskList→task_list、
//    TaskGet→task_get——本仓注册名，指称的工具必须在工具列表里存在）；
// ② schema 不设 additionalProperties: false（本仓校验层探活不支持布尔节点——实现层口径）；
// ③ 张力提法保留原文、语义以实现为准（"current coding session" 在修订B per-session 桶下
//    与实现一致（张力已消解——docs/TODO.md §13.1）；"shown in spinner" 本仓无 spinner 面、
//    字段照存；"Plan mode" 本仓无该面，场景指引无害；TaskList 的 owner 认领在单会话内是
//    规格带来的虚指——字段照存，§13.1 落档）。

export const TASK_CREATE_DESCRIPTION = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

It also helps the user understand the progress of the task and overall progress on their requests.

## When to Use

Use this tool proactively in these scenarios

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the planned work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use

Skip using this tool when:

- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use task_update to set up dependencies (blocks/blockedBy) if needed
- Check task_list first to avoid creating duplicate tasks`;

export const TASK_GET_DESCRIPTION = `Use this tool to retrieve a task by its ID from the task list.

## When to Use

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements`;

export const TASK_LIST_DESCRIPTION = `Use this tool to list all tasks in the task list.

## When to Use

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task

Prefer working on tasks in ID order (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones`;

export const TASK_UPDATE_DESCRIPTION = `Use this tool to update a task in the task list.

## When to Use

- Mark tasks as resolved:
  When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- Setting status to 'deleted' permanently removes the task
- Update task details:
  When requirements change or become clearer
  When establishing dependencies between tasks

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task

## Tips

- Make sure to read a task's latest state using task_get before updating it
- Mark task as in progress when starting work:
  \`{"taskId": "1", "status": "in_progress"}\`
- Mark task as completed after finishing work:
  \`{"taskId": "1", "status": "completed"}\`
- Delete a task:
  \`{"taskId": "1", "status": "deleted"}\`
- Claim a task by setting owner:
  \`{"taskId": "1", "owner": "my-name"}\`
- Set up task dependencies:
  \`{"taskId": "2", "addBlockedBy": ["1"]}\``;
