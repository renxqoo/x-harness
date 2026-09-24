# PLUGIN-AUTHORING：插件作者单一入口（任意功能 agent 平台）

> 你要做什么？下表是第一跳。每个机制的细节在对应包文档；本文只给路径与陷阱。

## 0. Where new behavior goes 总表

| 目标 | 机制 | 参考 |
|---|---|---|
| **组装一个成品 agent** | `@x-harness/harness` kit 目录 + 自有插件混入 → `createAgentWorld` | docs/SDK-MIGRATION-F1 |
| 加一个工具 | `createToolPlugin`（快路径）或 `registry.register` | §2 本文 |
| 加使用守则（工具在场才成立的提示词） | `guidance` 工厂参数（投稿式停靠） | §3 |
| 加任意提示词段（工具条件/环境感知） | `prompt.section({ text: () => ... })` 函数形 | §3 |
| 改写/否决进入的消息 | `transformMessages` / `vetoStep`（@x-harness/plugin-api） | §1 |
| 纠正 assistant 输出（幻觉修复） | `transformAssistant` | §1 |
| 拦截/包裹模型流 | `wrapStream`（agent 层）/ llm 包 `llm/stream`（全局面） | §1 |
| 自定义工具权限 | `vetoTools` | §1 |
| 改写工具输出 | `transformToolResult` | §1 |
| 改拨号参数（模型/温度/thinking） | `transformDial` | §1 |
| 观察一切（指标/审计/成本） | `tap*` 家族；`tapSessionEvents` 逃生舱 | §1 |
| 加一个 LLM 档案 | `llmRuntime.registerAdapter` | docs/LLM.md |
| 加一个能力 seam（settings/state/credentials…） | 能力插件模式（§5） | — |
| 测试你的插件 | `@x-harness/testkit` + 本文 §6 装置 | §6 |
| 动态安装/卸载插件 | `@x-harness/plugin-manager` | — |

## 1. 中间件原语：@x-harness/plugin-api（推荐入口）

四类纯函数 archetype——**next 纪律与洋葱序由框架结构性保证，你只写业务判断**：

```ts
import { transformMessages, vetoTools, transformAssistant, wrapStream, tapSessionEvents } from "@x-harness/plugin-api";

export const myPlugin: Plugin = {
  name: "my-guard",
  apply(ctx) {
    return [
      vetoTools(ctx, (call) => destructive(call) ? { kind: "deny", reason: "needs approval" } : undefined),
      transformAssistant(ctx, (s) => hallucinated(s) ? corrected(s) : s),
    ].reduce(...); // 组合 disposer（或手写逐一返回）
  },
};
```

**洋葱纪律**（框架已内建，写裸中间件时才需要知道）：中间件必须调 `next`；否决一律「先 next 后 deny」（内层副作用保留，最外层否决胜）。

## 1.5 内部消息（agent/message）与收束窗口（agentTurnConclude）

- **内部消息**（harness → 模型的注入消息：模型可见经投影 user 角色、UI 按类型隐藏、压缩按
  kind 分流）：写入 = `session.append("agent/message", agentMessageData({turn, step, source, kind, content}), {surfaceOp:"append"})`
  ——构造器/谓词单一真相在 `@x-harness/session`（agent-message.ts）。**扩展契约（开闭）**：
  新来源（source 开放，命名空间 `"<域>-<含义>"`，如 `delegation-report`）零登记接入，三消费方
  （模型/UI/摘要）零改动；消费方禁止按 source 分支；kind 闭集 `{directive（指令——摘要跳过）,
  content（内容——摘要保留）}`，扩闭集走 docs/AGENT-MESSAGE.md §4 场景 B 独立小方案。
  已知来源登记（纯文档）：`output-continuation`（agent-continuation 插件·directive）、
  `delegation-report`（agent-delegation 完成通知·content）、`bash-task`（task-tools
  bash 任务完成通知·content）。
- **内部消息投递 API**：`agent.notify(source, kind, text)`——next-step 排队 + 唤醒（steer
  同款步边界），领取时材料化为 `agent/message{source, kind}`。
- **收束窗口** `agentTurnConclude`（waterfall）：无工具 settle 即将结束 turn 的通用时点——
  续跑类策略（如输出截断续写）挂此窗口。中间件纪律：**必须调 next 至少一次**（内核违约
  throw 逃逸收轮）；让位 = 透传 `await next(payload)` 下游结果；放弃用 `{kind:"fail", message,
  code}` 应答而非 throw；返回垃圾形状 fail-loud。**冲突优先级**：装配序在后者（更内层）的非 undefined
  应答胜——要覆盖缺省策略的自定义件必须装配在 `continuationKit()` **之后**（与 compaction 自愈对
  llm-retry 的让位语义同构）。参考实现：`@x-harness/agent-continuation`。

## 2. 工具插件：createToolPlugin 快路径

```ts
createToolPlugin({ name: "tool-mine", make: (env, extraRootsOf, rootOverrideOf) => defineTool({...}), gate,
  observed?, env?, attach?, guidance? })
```

陷阱表（每条有代码依据）：
- **guidance 空串不落段**（local env 的 bash 零守则）；`schemas()` 不含 guidance（LLM 序列化面干净）
- **gate 根一致 fail-closed**：env.root 与 gate.root 错配 = 装配期 throw（执法面漂移拒绝）
- **env 三级解析**：工厂参数 > execEnv 服务 > throw
- **isControlTool** 标记控制类工具（permission 直通）；并发分类器抛错 = exclusive（fail-closed）
- **softInject 已声明**（system-prompt/sandbox-local/permission）——你的世界怎么摆数组序都正确；**自定义 tryUse 停靠请同样声明 `softInject`**（名漂移=静默退化为数组序，无告警——这是已知边界）

## 3. 提示词投稿面

- **三分法**：怎么调用 → 工具 description；因存在而如何行事 → guidance 段；跨工具策略 → 装配方
- 锚点词汇表 `wellKnown`（内核所有）：`baseCore`——工具段/追加段的缺省锚；缺席锚 no-op 落尾
- `text: () => string` 函数形：assemble 期现算（此刻 registry 已满——工具条件提示词的原生解）；抛错 → 段级降级占位
- **会话层** `prompt.scoped(sessionId).section`（锚定子集：只锚根层段名）；追加段链 = 无边落尾（宿主后置注册）

## 4. 概念地图（30 秒版）

`Plugin { name, inject?（硬依赖 topo）, softInject?（在场则排后）, apply(ctx) → Disposer }`；
`ctx` 六类 token：service（provide/use/tryUse）· event（emit/on）· waterfall（中间件）· serial · guard（只可否决）· parallel；
插件代码 = **宿主信任域**（围栏/权限约束模型驱动的动作，不约束插件代码——持久化/IO 自便）。

## 5. 能力插件模式（「需动底层才能实现吗？」——否就不进底层）

```ts
export const myCapability = defineService<MyApi>("my-capability");   // token 随你的包发布
export const myCapabilityPlugin = { name: "my-capability", apply: (ctx) => ctx.provide(myCapability, impl) };
// 消费方：依赖你的包拿 token（对象身份=模块单例）；tryUse 优雅降级
// 提供方可换：宿主 provide 另一实现（同层覆盖）；装饰：use 内层 → provide 包装版
```

**token 惯例**：token 随服务定义包发布；消费别人的服务 = 依赖其包；禁止复用平台 token 名（plugin-manager 装期同名异体 throw）。
**微调他人插件三式**（~~四式~~——use+provide 装饰在内核走不通：provide 同层重复 throw）：
waterfall 后置链（看到前者输出）/ `{prepend: true}` 前置 / kit 组合保序。
服务级包装用 waterfall 替代（wrap execute/preExecute 管线），不用 provide 重注册。

## 6. 测试你的插件

```ts
import { scriptedAdapter, textScript, fakeTool } from "@x-harness/testkit";
// 最小世界：inlineSessionKit + llmKit([scriptedAdapter({ scripts: [textScript("reply")] })]) + promptKit() + toolboxKit({root}) + loopKit() + meterKit()
// 装置参照：packages/e2e/src/agent-journey.ts
```

## 7. 契约稳定性规矩

**冻结面**：Plugin 接口 / 六类 token 形状 / token 名词表 / waterfall payload。
**pre-stable**：新拦截面的载荷字段（变更附迁移说明）。
**最少面原则**：新增拦截 token 须证明现有面组合无法表达（反混乱五原则之四——全表见 docs/SDK-DESIGN §0）。
