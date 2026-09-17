# Agent 设计（件 D：registry 与组合窗口）

> 状态：**讨论中，未写实现代码**。[DESIGN.md](./DESIGN.md) §3.2 六件套之 D 件。
> 契约一句话：**Agent 公共面极小；一切组装发生在 setup 组合窗口——composes, never drives。**

## 1. 公共面

```ts
interface Agent {
  readonly id: SessionId
  readonly ctx: Context          // agent 专属 scoped context——per-agent 插件注册面
  // 运行时面（declaration merging 叠加）：send / steer / cancel / whenIdle / status…
}
```

## 2. 构造与 setup 组合窗口

```ts
ctx.agents.create({
  sessionId,
  parentAgent?,                  // 委托谱系
  options,                       // 创建期数据：初始拨号（provider/model/思考档）——数据不是实现
  setup?,                        // 组合窗口
})

type AgentSetup = (agentCtx: Context, agent: Agent) => Promise<void>
```

**setup：composes, never drives**——在 agent 对外可见之前，把该 agent 的 scoped 世界（工具、prompt 段、监听、子插件）装好；失败整体回滚。发布次序：enter → announce（`agent/created`）。初始 options（初始拨号）与适配器（实现）分离：适配器由插件注册进 Runtime（LLM.md），选择是每 agent 的数据。

## 3. 子代理继承

- **拨号**：child options = 父当前 fold 值（数据拷贝，无实例派生）。
- **注册面**：经 `agent.ctx` scope 继承 + 就近遮蔽（CONTEXT.md §3）。
- preset 组合（per-agent 插件子树的声明式组装）——待讨论。

## 4. 总线词表（registry 件拥有）

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `agent/created` | emit（root） | `{ agentId, parentId? }` | deep | setup 提交并发布后 |
| `agent/idle` | emit（agent 链） | `{ agentId }` | deep | quiescence 达成（宿主/子代理管理器消费；发射方是 loop，词条归 registry 域） |
| `agent/terminated` | emit（root） | `{ agentId, reason }` | deep | scope 回卷完成后 |

## 5. 待讨论

- preset 组合协议（per-agent 插件子树的声明式组装形态）
- ScopeFilter 与 agent scope 的协同形状（CONTEXT.md 待讨论项联动）
