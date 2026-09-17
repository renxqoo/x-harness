# Session 设计（件 B：事实保管者）

> 状态：**讨论中，未写实现代码**。[DESIGN.md](./DESIGN.md) §3.2 六件套之 B 件；通过「事实保管测试」进内核——保管不可撒谎的事实，是铁律 L1/L2/L3 的执行点。
> 契约一句话：**append-only 事件日志 + 读时折叠；一切运行期状态是 `events()` 的纯函数派生。**

## 1. 契约

```ts
export interface SessionEvent {
  readonly seq: number                 // 单调
  readonly ts: number
  readonly type: string                // 词表 = §3 最小事件集（封闭，见 §3）
  readonly data: unknown               // 形状门由词条 owner 在写侧校验
}

export interface Session {
  readonly id: SessionId               // branded
  append(type: string, data: unknown): Result<SessionEvent, string>
      // 形状门校验 → 持久化端口写入 → 广播 'session/event'
  events(): readonly SessionEvent[]
}

export interface SessionPersistence {  // 端口：core 附带 memory 实现；fs 实现归 standard（D17）
  load(id: SessionId): Promise<readonly SessionEvent[]>
  append(id: SessionId, event: SessionEvent): Promise<void>
}
```

## 2. 折叠读面

「当前状态」= `events()` 的纯函数派生。最小读面是**尾折 last-wins**（形状门滤垃圾）：

```ts
foldTail(events, type, guard): unknown | undefined
```

结构化投影（`ProjectionDefinition { key, init, apply }`）等出现第一个需要累积态的域再引入——不为对称性预写。

## 3. 最小事件集（本质性测试推导定稿，9 条）

| 事件 | 事实 | 备注 |
|---|---|---|
| `user/message` | 输入（含 steer 注入，带 turnId） | turn 起点 = 共享 turnId 的首个事件 |
| `assistant/message` | 输出：内容（含 tool_use 块）+ usage + 实际拨号方 + stopReason | **消息即账本**；step 终点标记；工具调用请求的唯一记录处（删 tool/call——同一事实不落两处） |
| `tool/result` | 工具执行结果（outcome/content），按 toolCallId 关联回 assistant 的 tool_use 块 | 拒绝/阻断也走这里（outcome=denied） |
| `request/header` | 请求信封：拨号 config + 工具表快照（DESIGN D18）+ turnId/stepId | 兼 step 起点标记；读链「上次 header」来源（LOOP.md §1） |
| `model/selection` | 当前拨号（last-wins） | |
| `permission/mode` | 权限档（last-wins） | |
| `history/splice` | 投影原语：区间不可见 + 内联替代 | 世代 = splice 计数派生；压缩/滑窗/上下文编辑/fresh start 全是插件对它的组合，策略归插件（D19） |
| `turn/end` | 终态判决 `{turnId, reason}`（end_turn/budget/error/cancel/steer 耗尽…） | **唯一不可折叠的 turn 事实**——end_turn ≠ turn 结束（steer 可续航），终态只能自述 |
| `plugin/record` | 插件持久记录槽 `{plugin, kind, data}` | 单级词表对偶面（CONTEXT.md C9）：印章归插件名，形状门与类型化读取器由插件自带 |

**词形硬要求：所有会话事件携带归属键**（turnId/stepId/toolCallId，按事件类型适用——stepId 铸于 loop、落在 header 与 assistant 上；toolCallId 为模型侧不透明串）。链路审计与一切折叠读面的前提。

## 4. 总线词表（session 件拥有）

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `session/event` | emit | `{ event: SessionEvent }` | deep（构造时已冻结） | 每次 append 后广播——持久事实的唯一观察桥 |

## 5. 决策引用

D17（fs 归 standard）· D19（history/splice 投影原语）· D20（最小事件集推导）· CONTEXT.md C9（plugin/record 与总线信封对偶）。

## 6. 待讨论

- 9 条事件的**字段级 data 形状**（每条的精确字段、归属键类型）——M1 前收口
- **一 session 一 writer** 的并发假设写明与验证
- 事件 schema 版本化/演进策略（远期）
