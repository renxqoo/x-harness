export const TASK_STOP_DESCRIPTION = `Stops a running background task by its ID

- Takes a task_id parameter identifying the task to stop: a sub-agent's agentId (from agent_spawn) or a bash background task id (from bash run_in_background)
- Stopping a sub-agent is not destroying it — you can agent_message it again later with its context intact
- Idempotent: stopping an already-stopped or already-finished task returns its current status
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`;
