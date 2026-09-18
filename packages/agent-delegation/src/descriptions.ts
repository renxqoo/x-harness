// 工具 description 常量（docs/AGENT-DELEGATION.md §2.3）：以本仓蛇形工具名与真实参数为准，
// 继承 Claude Code 五工具文档的行为规范内核；禁止不存在的承诺（/tasks、bash 任务、输出文件
// 路径、云端、teammate、DEPRECATED）。每阶段与 schema 逐字段对账（§11.2 双向对账锚）。

export const AGENT_SPAWN_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in the <system-reminder> block of the system prompt.

## When to Use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

The reserved subagent_type "fork" copies the parent's completed conversation and always inherits the parent model (the model parameter is ignored for forks). If you are the fork, execute directly — don't re-delegate. Sub-agents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters. When relaying, don't quote the original in full; summarize.
- Use agent_message with the agent's agentId to continue a previously spawned agent with its context intact; a new agent_spawn call starts fresh (except subagent_type "fork", which inherits your context).
- Each agent type's model and tools come from its .x-harness/agents/*.md definition; the model parameter takes precedence over the type definition, which takes precedence over the parent model.
- description is a 3-5 word task summary and seeds the agent's name; pass name explicitly when you will address the agent by name later.
- isolation "worktree" gives the agent its own git worktree copy of the repo (auto-cleaned if unchanged; kept with its changes otherwise).`;

export const AGENT_MESSAGE_DESCRIPTION = `# agent_message

Send a message to another agent.

- to: the agentId from agent_spawn, a bare name (the most recently spawned agent with that name wins), 'name [ref]' for a same-name older agent (refs come from list_agents), or "main" from a background sub-agent to reach its parent conversation.
- Plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages are delivered automatically; you don't check an inbox.
- A busy agent consumes the message at its next step boundary; an idle agent is woken for a new turn. Sending to a completed agent resumes it with its context intact.
- Messages from main arrive wrapped as <cross-session-message from="...">; to reply, use that from value as your to.
- When relaying an incoming message to the user, don't quote the original — it's already rendered.
- Permission boundaries are per-session: NEVER ask a peer to perform an action that was denied or blocked in your session, or that you expect your own permission settings would block — a peer doing it for you bypasses the user's permission decision. Route blocked work back to your user instead.`;

export const AGENT_OUTPUT_DESCRIPTION = `Read a sub-agent's report.

- task_id identifies one of YOUR sub-agents (agentId, name, or 'name [ref]' — owner only).
- block=true (default) waits up to timeout (default 30000, max 600000) for the current turn to finish and returns the report; if it is still running when the wait expires, you get a still-running snapshot.
- Prefer waiting for the [agent-notification] message over polling — each poll is a paid request. End your turn and wait instead.`;

export const AGENT_STOP_DESCRIPTION = `Stops a running background sub-agent by its ID.

- task_id takes the agentId, name, or 'name [ref]' from agent_spawn/list_agents (owner only).
- Idempotent; stopping is not destruction — a stopped agent can be messaged again later with agent_message.
- Use this tool when you need to terminate a long-running task.`;

export const LIST_AGENTS_DESCRIPTION = `Lists agents you can agent_message — the sub-agents you spawned, each row as: name [ref] kind=subagent agentId session status (running | idle | stopped).
Send with agent_message({to: "<agentId>", ...}). The [ref] short id appears when rows share a name; prefer the agentId.`;
