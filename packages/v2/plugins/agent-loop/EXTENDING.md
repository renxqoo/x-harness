# 普通插件扩展 Agent

扩展入口是公开契约。用 definePlugin 声明依赖，用 ctx.guard/ctx.middleware 注册，调用依赖时使用本次 call.deps。

| 契约            | 行为                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| agentRunAccess  | 默认 required；上下文前、实际模型请求前、工具提交前检查可信 caller 与请求；拒绝不能被显式 allow 覆盖                           |
| agentContext    | 输入 runId/step/caller/metadata?/request，返回 AgentModelRequest；可调整模型/消息及缩减工具，不能提供 signal 或放大工具 schema |
| agentCheckpoint | 等待确认的持久化链，返回 void；失败阻止后续动作                                                                                |
| agentContinue   | 完整工具回执保存后检查；任一拒绝以 policy 结束，允许不突破预算                                                                 |
| agentEvent      | 同一流事件的有界异步通知；不替代等待确认                                                                                       |

```ts
import { definePlugin } from "@x-harness/core";
import type { JsonValue } from "@x-harness/core";
import { session } from "@x-harness/session";
import {
  agentRunAccess,
  agentContext,
  agentCheckpoint,
  agentContinue,
} from "@x-harness/agent-loop";

export const applicationAgent = definePlugin({
  name: "application-agent",
  requires: { agentRunAccess, agentContext, agentCheckpoint, agentContinue, session },
  setup(ctx) {
    const access = ctx.guard("agentRunAccess", (input) => ({
      ok: true,
      value:
        input.caller.origin.scopeId === "root"
          ? { kind: "allow" }
          : { kind: "deny", reason: "caller-not-approved" },
    }));
    if (!access.ok) return access;
    const context = ctx.middleware("agentContext", (input, next) =>
      next({
        ...input,
        request: {
          ...input.request,
          messages: [
            { role: "system", content: [{ type: "text", text: "Answer precisely." }] },
            ...input.request.messages,
          ],
        },
      }),
    );
    if (!context.ok) return context;
    const checkpoint = ctx.middleware("agentCheckpoint", async (input, next, call) => {
      const head = await call.deps.session.get({ id: "conversation" });
      if (!head.ok)
        return { ok: false, error: { source: "agent-loop", code: "checkpoint-failed" } };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([input.runId, input.step, input.phase])),
      );
      const commitId = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const saved = await call.deps.session.append({
        id: "conversation",
        expectedRevision: head.value.revision,
        commitId,
        entries: [
          {
            kind: "event",
            type: "agent/checkpoint",
            data: JSON.parse(JSON.stringify(input)) as JsonValue,
          },
        ],
      });
      return saved.ok
        ? next(input)
        : { ok: false, error: { source: "agent-loop", code: "checkpoint-failed" } };
    });
    if (!checkpoint.ok) return checkpoint;
    return ctx.guard("agentContinue", (input) => ({
      ok: true,
      value: input.step < 4 ? { kind: "allow" } : { kind: "deny", reason: "application-limit" },
    }));
  },
});
```

检查点逻辑身份使用 runId/step/phase；例子将三元组哈希为固定 64 位十六进制 commitId，满足 session 的字符与长度约束，不能直接拼接任意 runId。

context 阶段批准执行上下文扩展，可先验证 caller 与 metadata 的会话归属；model/tools 阶段检查扩展后的实际模型和工具集合。需要自动筛选工具时，可由上下文插件缩减，再在后两个阶段执行严格工具白名单策略。

例子假设宿主已经创建 conversation 并安装 session 与独立存储插件。实际应用应从可信身份与运行映射选择会话，不能让模型参数自报会话归属；同一会话的运行互斥也由宿主管理。revision 冲突会使保存失败并阻止后续执行，不是自动合并或分布式运行锁。存储返回不确定错误时可用 session.getCommit 查询同一 commitId，由外部存储策略决定如何确认，循环不自行重试。

response 检查点在模型响应校验后、工具提交前；messages 可能包含待执行 assistant 工具调用。tools 检查点包含本轮全部配对消息及逐项 results，返回者为 returned，设施失败为 unknown。输出、callId、原始 response 和消息对应关系均验证；不能把没有回执的 intent 当作工具完成。

完整 continuation、引用与模型可见上下文保存在事件中。SessionMessage 投影不能表达所有厂商续接数据，所以例子保存 session event；session.conversation 不会自动把这些事件变成通用聊天消息。展示与对话投影由独立适配插件负责。

恢复时通过 session.history 读取固定 revision 的记录，并保留完整分页与大小预算。最后一个完整工具结果检查点或无待执行调用的最终 response 可以作为显式续跑输入；response 只有意图而缺 tools 回执时，工具可能未开始、已执行或仍在运行，必须先对账。unknown 结果、整批失败、core 取消或超时不能自动重放。业务 exactly-once 需要工具幂等键及外部事务协议，普通循环与一次 JSONL/SQLite 写入无法提供。

检查点返回完整消息保留原历史；上下文插件提供的临时摘要仅用于本轮 request。压缩或用户消息插入应经 agentContext 明确处理，并保存实际 request 供审计。agentRunAccess 负责阶段准入；运行中实时撤销使用 tools 的可撤销完整计划许可或外部 signal。审批、LLM 评估、记忆及界面均可各自作为普通插件实现。
