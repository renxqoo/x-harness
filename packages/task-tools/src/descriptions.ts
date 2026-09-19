// 工具 description（docs/TASKS.md §1.1/§9）：正文取 Claude Code 规格原文（源
// /Users/wrr/work/claude-tool/agent-and-background-tasks.md），偏离按类别落档件14：
// ① 不继承 DEPRECATED 前言与文件指针/Read 替代路径（件13 U2——本仓无一等文件指针路径，
//    task_output 即一等读面）；
// ② 删「/tasks command」行与本仓不存在的 id 来源（id 来源=agent_spawn 结果与 bash
//    run_in_background 返回值，两处 bullet 的括注随之改写）；
// ③ 删 name@team/按名停止两行（件13 修订A 去名——agentId 是唯一身份）；
// ④ 删 remote session（kind 闭合 agent|bash——remote 归云接入件）；
// ⑤ 增 offset/block:false 轮询/Idempotent/停止非销毁复活引导（本仓扩展与既有语义，
//    描述明写防误用）。

export const TASK_OUTPUT_DESCRIPTION = `Retrieves output from a running or completed task (background shell or agent)

- Takes a task_id parameter identifying the task: a sub-agent's agentId (from agent_spawn) or a bash background task id (from bash run_in_background)
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- For long-running tasks (dev servers), poll progress with block:false instead of waiting
- timeout (ms, 0-600000) bounds the wait; timeout=0 returns an immediate snapshot
- offset (repo extension): resume reading at the byte offset the previous response reported as nextOffset — incremental reads for bash tasks; ignored for agents`;

export const TASK_STOP_DESCRIPTION = `Stops a running background task by its ID

- Takes a task_id parameter identifying the task to stop: a sub-agent's agentId (from agent_spawn) or a bash background task id (from bash run_in_background)
- Stopping a sub-agent is not destroying it — you can agent_message it again later with its context intact
- Idempotent: stopping an already-stopped or already-finished task returns its current status
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`;
