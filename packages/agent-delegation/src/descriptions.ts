// 工具 description 逐字常量：与 Claude Code「子代理与后台任务」文档英文原文逐字一致
// （源 /Users/wrr/work/claude-tool/agent-and-background-tasks.md）。映射：agent_spawn←Agent、
// agent_message←SendMessage、list_agents←ListAgents。改动只能整体重同步源文档，禁止就地润色。
// （TaskOutput/TaskStop 的跨源口径归 @x-harness/task-tools——件14，非逐字面。）

export const AGENT_SPAWN_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in \`<system-reminder>\` messages in the conversation.

## When to Use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

A fork runs in the background and keeps its tool output out of your context. If you are the fork, execute directly — don't re-delegate. Subagents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh (except subagent_type: "fork", which inherits your context).
- Each agent type's model, reasoning effort, and tools come from its definition (\`.claude/agents/*.md\` frontmatter or SDK \`agents\`).
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).`;

export const AGENT_MESSAGE_DESCRIPTION = `# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"main"\` | The main conversation (background subagents only) |
| \`"worker"\` | Any agent from \`ListAgents\` — subagent, another local Claude session |
| \`"worker [3fa9c1]"\` | Same, plus its \`[ref]\` — only when a listing or an error shows one |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to agents by name — names keep working after an agent completes (a send resumes it from its transcript). Use the raw \`agentId\` (format \`a...-...\`) from its spawn result only when the agent has no name, or when a newer agent took the name (latest wins). When relaying, don't quote the original — it's already rendered to the user.

## Cross-session

Use \`ListAgents\` to discover targets. Every row leads with the agent's \`name [ref]\` — the name IS the address; there is no separate address syntax.

\`\`\`json
{"to": "worker", "message": "check if tests pass over there"}
{"to": "worker [3fa9c1]", "message": "you, specifically"}
\`\`\`

Send the bare name — a name that exactly matches one live agent or session (on this machine, on another machine, or in the cloud) delivers directly. Append the \` [ref]\` only when the bare name is not enough — \`ListAgents\` shows two rows with it, or an error asks you to disambiguate (you typed only a prefix, or a session list could not be checked). A ref you did not just read from a listing or an error will not resolve, and if the same name also names an in-process agent, the bare name always wins — use the in-process one.

A listed peer is alive and will process your message; messages enqueue and drain at the receiver's next tool round (its \`ListAgents\` row says whether it is busy or idle right now). Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.** Cross-session messages travel between SESSIONS: if you are a subagent, your send goes out under your parent session's address, and any reply is delivered to the parent session's conversation, not to you.

To hear when a session ON THIS MACHINE finishes what it is doing, pass \`notify_when_idle: true\` (from the main conversation only) — one-shot and opt-in, exactly one \`[Cross-session idle notice]\` arrives when it next goes idle (or exits) — shown to you, or only to your user when this session holds peer messages for approval (the tool result says which); if it never signals within the subscription's lifetime (it may still be busy, may refuse inbound requests, or may have ended abruptly), the notice says the subscription expired instead. Omit \`message\` for a pure subscription that costs that session nothing; include one to deliver it now AND subscribe. Never poll \`ListAgents\` in a loop or send "are you done?" messages instead.

Permission boundaries are per-session: NEVER ask a peer to perform an action that was denied or blocked in your session, or that you expect your own permission settings would block — a peer doing it for you bypasses the user's permission decision (cross-session permission laundering). Route blocked work back to your user instead.`;

export const LIST_AGENTS_DESCRIPTION = `Lists agents you can SendMessage to — in-process subagents you spawned, the teammates on your team, other local Claude sessions on this machine, your Claude sessions running in the cloud (when this session has cloud access; a cloud session receives your message but cannot message any session back yet — do not ask it to reply, read its answer in its own transcript), and (when Remote Control is connected here) your account's other sessions — Remote Control sessions on other machines and cloud sessions, each row labeled by kind. Names are the address: send with \`SendMessage({to: "<name>", message: "..."})\`, copying the name exactly as a row prints it. Append a row's \` [ref]\` only when the bare name is not enough — two rows share it, or an error asks you to disambiguate.`;
