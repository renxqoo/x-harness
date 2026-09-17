# 工具执行管线设计（件 F：执法通道）

> 状态：**讨论中，未写实现代码**。[DESIGN.md](./DESIGN.md) §3.2 六件套之 F 件；通过「执法测试」进内核——不可以被执法者替换的通道。工具与权限**策略**全是插件（裁决、审批 UI、治理规则）；本件拥有的是**次序与底线**。
> 契约一句话：**pre 裁决 → ask 必须被决出 → guard 单调否决 → execute → post → result 落账；缺 answerer = fail-closed，不许默认放行。**

## 1. 执法次序

```
ToolExec（来自 assistant 消息的 tool_use 块）
  1. tool/pre（waterfall）    → allow / deny{reason} / ask{reason}     —— 权限插件的主战场
  2. ask → answerer 端口      → approval/asked + approval/decided 审计对
       answerer 缺失 / 未决 / 抛错 = fail-closed 拒绝执行
  3. tool/guard（guard）      → 单调否决：全部执行、只能加 deny、无 allow 可翻回
  4. tool/start（emit）       → UI 发令枪（权限链已过、执行前）
  5. tool/execute（waterfall）→ final = 真实执行；超时/计量/幂等检查的挂靠面
  6. tool/post（waterfall）   → accept / replace / block
  7. tool/result              → 总线 emit（冻结快照）+ 会话落账（按 toolCallId 关联）
```

被拒调用：不发射 tool/start；拒绝事实走会话 tool/result（outcome=denied）→ session/event 广播。

## 2. answerer 端口（审批桥）

内核定义端口，插件注册实现（`approvalAnswererService`：`request(ask) → Promise<decision>`）。内核只保证：**ask 必须被决出才能执行**；决不出的方向永远是拒绝。审批 UI/确认流/超时策略全是插件。

## 3. ToolDefinition 契约骨架（待细化）

```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: TSchema                                   // JSON Schema 形状
  output: { schema; render; presentationMeta? }         // canonical 值 → 模型内容的纯投影
  execute(args, exec: { signal; progress(delta) }): Promise<ToolResult>
  timeoutMs?; isConcurrencySafe?(args): boolean; finalizeContent?
}
```

- `exec.progress(delta)`：流内进度——**管线折算为 `tool/progress` emit**，插件不得直发内核 token（发射权归内核件，CONTEXT.md C13；与 answerer 端口同模式）。
- 超时/取消：exec.signal 贯穿；超时值与执行策略可被 execute 中间件盖写。

## 4. 注册表与调度

- 注册经 `toolsService.register(def)`；scope nearest-first 遮蔽（scoped 工具 shadow 全局同名——spawn 继承的基础）；`restrict({allow, deny})` 只能收紧。
- 并发调度：**机制归本件，策略可盖写**——起步串行；`isConcurrencySafe(args) === true` 的分阶段并行 + 互斥屏障为后续版本（D18 快照语义下，注册表变更于下一次组装点生效）。

## 5. 总线词表（本件拥有 final 与发射权）

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `tool/start` | emit（agent 链） | `{ toolCallId, toolName, input }` | deep | 执行起点信号——UI 的发令枪，与 `tool/result` 成对；被拒调用不发射 |
| `tool/progress` | emit（agent 链） | `{ toolCallId, delta }` | **none（高频豁免）** | 长任务工具的流内进度；生产者 = 管线经 `exec.progress()` 回调 |
| `tool/pre` | waterfall | 入 `ToolExec`；出 `{ kind: "allow" \| "deny" \| "ask"; reason? }` | deep | 裁决面：权限插件的主战场 |
| `tool/guard` | guard | `ToolExec` → deny-only | deep | 单调否决：全部执行、只能加 deny（治理插件） |
| `tool/execute` | waterfall | 入 `ToolExec`；出 `ToolResult` | deep | around 派发：超时/计量/幂等检查的挂靠面，final = 真实执行 |
| `tool/post` | waterfall | 入 `ToolExec & { result }`；出 `{ kind: "accept" \| "replace" \| "block" }` | deep | 结果改写/阻断 |
| `tool/result` | emit（agent 链） | 冻结快照 | deep | 执行侧事实广播（落账在会话事件侧） |
| `approval/asked` | emit（agent 链） | `{ askId, toolName, reason? }` | deep | 审计对之一 |
| `approval/decided` | emit（agent 链） | `{ askId, decision, source? }` | deep | 审计对之二 |

## 6. 决策引用

试金石：idempotency → `tool/execute` + `tool/result`（toolCallId 账本核对）· CONTEXT.md C12（成对律）/ C13（发射权）· D18（注册表快照）。

## 7. 待讨论（M3 前收口）

- ToolDefinition 细节：output 投影的 schema/render 精确形状、finalizeContent、presentationMeta
- ToolResult 形状（含 denied/blocked 变体）
- 并发调度器机制细节（分阶段并行 + 屏障）
- guard 注册的时点语义（与 pre 的次序保证）
