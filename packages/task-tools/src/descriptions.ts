// 工具 description（docs/TASKS.md §1.1/§9 + docs/TASK-PUSH-DESIGN.md §2.1）：task_stop 单工具（读面归日志文件与
// [task-notification] 推送；正文取 Claude
// Code 规格原文并按本仓形态改写：id 来源=agent_spawn 结果与 bash run_in_background
// 返回值、无 name@team/按名停止、无 remote session）。

export const TASK_STOP_DESCRIPTION = `Stops a running background task by its ID

- Takes a task_id parameter identifying the task to stop: a sub-agent's agentId (from agent_spawn) or a bash background task id (from bash run_in_background)
- Stopping a sub-agent is not destroying it — you can agent_message it again later with its context intact
- Idempotent: stopping an already-stopped or already-finished task returns its current status
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`;
