# AGENT-MESSAGE 内部消息子系统

> 状态：定稿（随输出截断续写功能首批落地：类型 + 第一个消费者；delegation 迁移为第四批）
> 定位：harness → 模型的**注入消息通道**，与四类消息（system/user/assistant/tool）平级的第 5 表面类型。
> 模型可见、UI 类型级隐藏、压缩按 kind 分流。本文件是该子系统的唯一规范——后续任何「发给模型但不给用户看」的消息按 §4 扩展程序接入，不改本文件以外的约定。

## §0 术语与边界

- **内部消息**：harness 侧产生、注入会话流给模型看的消息。不是用户发言（不落 `user/message`）、不是工具回传（不落 `tool/result`）。
- 与相邻机制的边界：
  - **inbox（agent/inbox/spliced）**是用户输入的排队机制（next-turn/next-step）——内部消息不走 inbox（排队语义归各投递方，见 §4 场景 C）；
  - **tool/result** 是工具调用的应答通道——工具结果永远是 tool/result，不迁本类型；
  - **system/message** 是系统提示词锚点——全局、每请求恒在；内部消息是点状、历史位置固定。

## §1 事件契约

```ts
// 表面事件类型（SURFACE_TYPES 第 5 类，append 落账）
type: "agent/message"
data: {
  turn: number; step: number;
  source: string;              // 来源标签：开放词表，写入方命名空间（§2 纪律）
  kind: "directive" | "content"; // 语义类：闭集（判定问题见下）
  content: ContentBlock[];     // 模型可见内容；text-only 起步（image 通道按需后开，扩闭集走 §4 场景 B 程序）
}
```

**kind 的判定问题（唯一标准）**：「这条消息的内容，压缩后模型还需要记得吗？」

- `directive`（指令）——告诉模型**怎么做**（喊话：继续写、拆小步）。价值在照做的瞬间耗尽，摘要跳过、零损失。
- `content`（内容）——告诉模型**事实/结果**（情报：子代理发现了什么）。压缩后必须存活，否则模型失忆自己派过的活。

**投影**：`surfaceToMessages` → `{ role: "user", content }`——协议事实：provider 只有 user/assistant 角色，harness 注入一律 user 角色。

**词表纪律**：`source` 只作诊断与写入方自引用（如计数折叠），**消费方禁止按 source 分支行为**——按 source 分支 = 中央登记表复活，破坏开闭契约。

## §2 代码架构（单一真相与模块分层）

```
packages/core/session/src/agent-message.ts      ← 子系统单一真相（新模块）
  ├ AGENT_MESSAGE_KINDS: ReadonlySet<"directive" | "content">   // kind 闭集
  ├ agentMessageData(input: {turn, step, source, kind, content})  // 构造器：形状单一出口
  └ isAgentDirective(event) / isAgentContent(event)               // 消费方谓词（serialize 等用）
packages/core/session/src/types.ts              ← SessionEventData 词条
packages/core/session/src/gates.ts              ← 形状门（引用 agent-message 闭集；image 块拒）
packages/core/session/src/surface.ts            ← SURFACE_TYPES + 投影 → user 角色
packages/compaction/src/serialize.ts            ← 用 session 谓词分流（不自定义 kind 判断）
packages/plugin-api/src/index.ts                ← 宿主面再导出（agentMessageData + 谓词 + 文档指引）
```

依赖方向：serialize/plugin-api → session（既有方向，无新边）。

**写入 API 三级**（全部经 `agentMessageData` 构造器——形状保证单一出口）：

| 级 | 谁写 | 怎么写 | 例 |
| --- | --- | --- | --- |
| 内核 | agent-loop（循环语义的一部分） | driver 内直接 `session.append("agent/message", agentMessageData(...), {surfaceOp:"append"})` | 续写指令（resume 决策应用） |
| 插件 | 任何插件 | `ctx.use(sessionStore)` 取会话后同款 append（compaction 落 replace 事件同模式） | delegation（第四批后） |
| 宿主/通道 | driver.inject 通道 | 形态待第四批探查钉死（inject 改型直写 vs 保留 inbox 语义另立写入点） | 见 §4 场景 C |

## §3 消费方矩阵

| 消费方 | directive | content | 判断依据 |
| --- | --- | --- | --- |
| deriveMessages（模型） | user 角色消息 | user 角色消息 | 投影恒 user（§1） |
| UI 客户端（渲染） | 隐藏 | 隐藏 | **类型白名单**：客户端只画已知消息类型，`agent/message` 天然不在表内——新类型默认不可见，零客户端发版 |
| UI 客户端（可选展示） | 自由 | 自由 | 想做调试面板/折叠卡片的客户端加一个 case 即可，协议不变 |
| serialize（压缩摘要） | **跳过** | **内容行保留** | kind 谓词（§1 判定问题） |
| cut（压缩切口） | 非候选 | 非候选 | 类型非 user/message（结构性，零代码） |
| host-hub 镜像 | 泛型外发 | 泛型外发 | 与 llm/retry 等同形态，hub 零判断零过滤 |

## §4 扩展程序（开闭契约——本子系统的存在理由）

**场景 A：新来源、既有 kind（预期 90% 的扩展）**
写入方在自己包内定义 source 常量（单一真相住写入方）→ append 一条 `agent/message`。
模型可见 / UI 隐藏 / 摘要待遇**全部自动成立**——零登记、零其它包改动、零子系统改动。
source 命名空间纪律：`"<域>-<含义>"`（如 `output-continuation`、`delegation-report`、`skill-notice`）；写入方文档登记一行（PLUGIN-AUTHORING 已知来源表，纯文档非代码登记）。

**场景 B：新 kind（预期罕见——真出现第三种摘要行为时）**
唯一需要动子系统的路径：扩 `AGENT_MESSAGE_KINDS` 闭集 + serialize 一处分支 + gate 一处校验 + 消费方矩阵一行。
纪律：必须独立小方案（本文件修订 + 审查轮），禁止顺手扩——闭集的价值在于它小。

**场景 C：新投递模式（如「等父模型安全边界再喂」的延迟投递）**
现存的排队语义（inbox next-step）落账为 `user/message`；若内部消息需要同等排队，候选形态是「inbox 条目材料化类型扩展」（claim 时按条目标记落 agent/message 而非 user/message）。
open axis：delegation 第四批探查结论决定是否需要——**需要才设计**，本文件届时修订。

## §5 存量流盘点与迁移地图

| 流 | 现状载体 | 迁移 | 归属 |
| --- | --- | --- | --- |
| delegation 完成通知（报告全文 + 缺档占位 + 异常终态透传） | `parentHandle.agent.steer(...)` → next-step → 领取 → **user/message**（notify.ts 两个交付点） | → `agent/message{source:"delegation-report", kind:"content"}`；reportDelivered 记账点随载体迁移；tearing-down 门 / 孤儿收养 / task_output 复查不复读语义不动 | 截断续写功能第四批 |
| 跨会话空闲通知（notify_when_idle 的 `[Cross-session idle notice]`） | 跨进程邮箱 → 主会话（交付点待探查确认是否同为 steer/user-message 形态） | → `agent/message{source:"cross-session-notice", kind:"directive"}`（过期作废的时点性通知） | 候选：delegation 迁移批内探查后定 |
| 续写指令（本功能） | —（新流） | 直接落 `agent/message{source:"output-continuation", kind:"directive"}` | 截断续写功能第三批 |
| 后续候选（示意） | — | 技能装载通知 `skill-notice/content`、预算告警 `budget-warning/directive` | 场景 A 零阻力接入 |

迁移纪律：每条流的迁移 = 载体替换 + 该流自身的投递时序/记账语义回归验证 + 对抗审查；三消费方待遇随类型自动成立，不在迁移流内重复设计。

## §6 测试架构

- **session（子系统本体）**：`agentMessageData` 构造器形状；gate 正反例（source 非空、kind 闭集、image 拒、缺字段）；投影 user 角色；既有四类投影零扰回归。
- **compaction**：serialize 用谓词分流（directive 跳过 / content 内容行）；cut 非候选回归。
- **迁移流（各自批次）**：模型可见性不变（calls 断言）+ UI 形态变化（不再出现 user/message 载体）+ 流自身语义回归（delegation：reportDelivered / 复读 / 异常窗口）。
- **e2e**：真装配旅程断言 WAL 事件序与 get_entries 类型呈现。

## §7.1 已知代价（审查落档）

- **搁浅指令**：directive 落卷后若续写步被 preStep 否决（blocked）或续写 attempt 致命失败（error 收轮），
  该指令从未被消费却永久留在投影——**下一次压缩吞掉之前，后续每条请求都带着这条过期喊话**（"Resume
  directly…"紧跟新问题，模型可能续写半截答案而非答新问题）。WAL 不可变无法回收；directive 不进摘要故
  下次压缩即消失。已知接受面（docs/OUTPUT-TOKEN-CONTINUATION.md 审查处置·代码轮 P7/低-3）。

## §7 裁决记录

- **类型级 UI 隐藏，而非标记字段**（用户裁决）：标记要求每个消费方记得检查，遗忘面大；类型白名单让新类型默认不可见——隐藏是结构性默认，不是检查项。
- **source 开放 / kind 封闭**（用户裁决·「易于后续扩展」）：来源零登记接入（场景 A 零改动）；语义类小闭集换扩展纪律（场景 B 独立方案）。二分轴 = 摘要存亡，非「谁发的」（后者会把子代理报告误吞进指令类——用户质询已验证此歧义，kind 值由 control 改名 directive 落档）。
- **持久载体，放弃瞬态**（用户裁决）：指令留存投影至压缩吞掉（有界）；瞬态尾部拼接方案被否——它要求修改「请求体 = deriveMessages() 纯折叠」内核不变量。
- **单一真相住 session 包**：构造器/谓词/闭集一处，消费方（serialize 等）不自定义判断；与「词表封闭住最底层被依赖的包」的仓规一致。
- **排队语义不进本类型**（默认裁决）：投递时序归投递方；若确需排队走场景 C 独立设计。
