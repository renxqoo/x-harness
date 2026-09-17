# Agent Loop 设计（件 E：默认驱动）

> 状态：**讨论中，未写实现代码**。[DESIGN.md](./DESIGN.md) §3.2 六件套之 E 件——turn/step 状态机语义写死在规范：**驱动可换、语义不可换**（换驱动 = 不装 loopPiece 装 myLoop，事件序与铁律不得改变）。
> 契约一句话：**读链提案 → compose 瀑布 → prepareCall → stream → 落账；每一步都是日志的纯函数消费。**

## 1. 读链统一（不是写径统一）

每步请求的拨号 config 按此链提案：

```
loop 提案：pending 选择(fold 尾值) → 上次 request/header(日志) → 初始 options(创建期数据)
  → request/compose 瀑布（插件可盖写——瞬时路由决策在这层）
  → llm.prepareCall（校验 + 解析适配器/元数据/maxTokens）
  → stream
```

请求内容面同理纯插件化（D16）：`system` 初值 = 上次 request/header 记录值或空串，`messages` = 日志投影（消息投影是本件职责，L2 的直接实现）；两者与拨号 config 同经 compose 瀑布可盖写，最终值落 request/header。

### 运行期状态端到端时序（模型/权限/思考档同机制：事件 + 折叠）

```
改模型（会话中途）：
  宿主命令 → resolveModel 校验（未知即拒）→ append 'model/selection'（落盘，last-wins）
  飞行中请求：config 已在 prepareCall 解析固化，天然不受影响
  下一步：    loop 提案 = fold 尾值 = 新选择 → prepareCall → stream
  UI 更新：   'session/event' 广播，宿主订阅
  重启：      fold 尾值仍在（没有回放步骤——折叠即应用）
  子代理：    child options = 父当前 fold 值（数据拷贝，无实例派生）

权限等级（full / confirm / …）：'permission/mode' 事件 + fold；权限插件的工具前置监听读 fold 裁决。
思考档：model/selection config 的一部分，不单独成事实。
坏值降级：垃圾值被形状门滤掉 → 读链落到下一环（上次 header / 初始 options）；
          形状合法但未知 → prepareCall 拒绝 → error 终态。
```

## 2. 状态机职责

- **turn/step 事件序**：turn 起点 = user/message（带 turnId）；step 边界 = request/header ↔ assistant/message 配对；终态 = turn/end 自述（reason: end_turn / budget / error / cancel / steer 耗尽）——无独立 start 类会话事件（D20 最小集）。
- **消息投影**：deriveMessages——从日志折出 LLM 消息历史（含 history/splice 的可见性折叠、steer 同 turnId 归并、tool/result 按 toolCallId 配对）。
- **quiescence / steer / cancel**：turn 收束窗口（`turn/stopping` serial）内 steer 注入续航；空闲判定发射 `agent/idle`。
- **step 否决点**：`agent/pre-step` waterfall——预算插件的挂靠面。
- **assistant 落账**：流终态 → assistant/message 事件（内容 + usage + 实际拨号方）——消息即账本。
- 工具调用：assistant 的 tool_use 块 → 工具管线（TOOLS.md）执行 → tool/result 落账 → 下一步提案。

## 3. 总线词表（loop 件拥有 final）

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `agent/pre-step` | waterfall | 入 `{ messages, config }`；出 `void \| { reject: "budget" \| "blocked" }` | deep | 每步放行门——**预算插件的挂靠面**；reject 直落 turn 终态 |
| `request/compose` | waterfall | 入/出 `CallDraft { system, messages, tools, config }` | deep | 读链统一层：持久选择与瞬时盖写都汇入此 |
| `turn/stopping` | serial | `{ steer(msg: Message): Result<unknown> }` | deep | turn 收束窗口：steer 注入续航（serial 保证全部监听者见到同一窗口） |

## 4. 决策引用

D5（读链统一）· D16（prompt 纯插件化）· D18（快照语义）· D20（step/turn 边界折叠）。

## 5. 待讨论（M3 前收口）

- inbox/steer 的精确时序（send 入队模型、steer 注入窗口语义）
- quiescence 判定（无在飞 step + 收件箱空 + 子代理静止？）
- 预算拒绝落点（turn/end 的 reason 已覆盖，是否还需独立观察面）
- system 指纹（组装版本标识）要不要进 request/header（KV-cache 观测）
