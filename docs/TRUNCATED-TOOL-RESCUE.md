# 截断 tool_use 识别与半截产出抢救方案

> 状态：草稿（讨论轮 2——pi-ai 修补链路发现后全面改版；裁决点 ④ 已随发现改判，③⑤⑥ 待用户最终拍板）
> 关联：docs/OUTPUT-TOKEN-CONTINUATION.md（截断续写——本件补其「tool_use 在场」缺口）；docs/STREAM-PARTIAL-PERSISTENCE.md（上游已交付数据不丢弃——本件是其工具面延伸，且本件要修它的一处违例，见问题定义）；docs/AGENT-LOOP-DRIVER.md §1.5（工具调度）；docs/LLM-PI.md（pi-events 出口契约）
> 级别：中偏高（llm 层 pi-events 出口改造 + agent-loop 内核一处收口 + 新 waterfall 词条 + tool-write 侧插件 + hub 目录装配面接线修复）
> 来源：事故——大文件 write 在 arguments 中途撞输出 token 上限（`finish=max-tokens`）；深挖 pi-ai 依赖源码后发现比事故表面更严重的**静默数据损坏**模式（模式 2）。

## 问题定义

模型响应因输出上限截断、且截断点落在 tool call 的 arguments 中途。这不是单一体位——按截断点位置分三种模式，后果严重度递增：

### 三种事故模式

| 模式 | 截断位置 | arguments 到达 agent 层的形态 | 后果 | 严重度 |
|---|---|---|---|---|
| 1 | arguments 刚起步（`{"` 之前或附近） | `{}`（pi-ai 修补产物） | TypeBox 违规回显 → 模型全量重试 → 再撞墙；带工具粘性 max-tokens 收轮终止 | 中（已观察事故） |
| **2** | **content 字符串中途** | **`{"path":"foo.ts","content":"半截…"}`——合法 JSON，TypeBox 校验通过** | **write 照常执行，半截文件静默落盘，返回 "Wrote foo.ts (N lines)" 成功回显——模型认为交付成功。无任何错误。静默数据损坏** | **P0（静默损坏）** |
| 3 | content 之后（后续键中途） | 合法对象缺后继键 | 多数工具照常执行（缺省参数语义）；基本无害 | 低 |

### 根因链（两层）

**根因 A｜pi-ai 在 llm 层把半截 JSON 修补成合法对象（模式 2 的成因）**：

pi 的 anthropic 适配器对 tool_use 参数流式累积时调用 `parseStreamingJson`（pi-ai `dist/api/anthropic-messages.js:502,543`；实现 `dist/utils/json-parse.js`）：完整 parse 失败 → `repairJson`（转义修复）→ **partial-json 库容错 parse**——`{"path":"foo.ts","content":"hal` 这类半截被**闭合成合法对象**。x-harness 的 `toolCallChunks`（packages/llm/src/pi-events.ts:98-109）拿到的是修补后的对象再 `JSON.stringify` 下发。后果：

- 到达 agent 层的 arguments **恒为合法 JSON**——任何下游「JSON.parse 失败 = 截断」的检测在这条链路上**永不触发**；
- WAL `assistant/message` 落的是**修补版而非上游真实交付**——一个「看似完整实则半截」的 content 入卷，resume/审计/replay 面上比真半截更害人（被当合法调用回放）。这本身就违反 STREAM-PARTIAL-PERSISTENCE 的本义（上游已交付数据如实落盘）；
- 模式 2 下 TypeBox 无法拦截（形状合法），执行面无感知——损坏直达磁盘。

**根因 B｜x-harness 无截断 tool_use 的识别与收场机制（三模式共通）**：

- 纯文本截断有续写机制（OUTPUT-TOKEN-CONTINUATION），带工具截断对收束窗口**结构性不可达**（窗口只在 `tools.kind === "none"` 可达——「有工具不续」是设计裁决）；
- 半截调用照常调度，模型收到的错误（模式 1）或成功（模式 2）回显都不含「截断」事实，无拆分引导。

**外围因素（层 0）**：输出上限配置低于模型真实上限（GLM preset `maxOutputTokens: 34_000`）；hub 目录**接线断口**——模型级 meta `maxTokens` 与 `modelOverrides.<key>.maxOutputTokens` 只进 `CatalogEntry` 展示面（get_models/contextWindow 解析用），不进请求体（`buildAssemblySnapshot` 只取 profile 级，shared/catalog.ts:161-172）——**模型级/override 级输出上限配置了也不生效**。

**层 2｜浪费**：write 的 content 只存在于半截参数里——WAL 记录的是修补版（根因 A）、磁盘无物化、模型不可见。大 write 34k 截断 case：理论最优 ≈ 51k 输出（34k 已烧 + 17k 补写），现状 68k+（全重写）且模式 1 下 turn 终止需人工重启。

### 三家实现对照（行为分叉根因）

| | Codex | ZCode | x-harness 现状 |
|---|---|---|---|
| 截断信号 | `response.incomplete` 折成可重试流错误，**盲重试原请求** | 归一 `length` → 续写指令（3 次上限） | 归一 `max-tokens` → 续写（仅无工具） |
| 半截 tool_use | 不物化——**协议保证**（Responses API 截断不发 `output_item.done`） | 不物化——**双闸门**（执行参数只认 final tool_call 事件；有 start 无 end 的 final 判不可信丢弃） | **物化且执行**——pi-ai 修补后形状合法，模式 2 直达磁盘 |
| 参数烂 JSON | RespondToModel 自纠 | 降 `{}` → schema error result | TypeBox 回显自纠（仅对未被修补的） |
| 输出上限配置 | 不设，吃服务端默认 | 每轮打满模型声明上限 | preset/profile + 断口 |

关键定位：**ZCode 的闸门在 adapter 层（AI SDK 流事件生命周期）；x-harness 的等价闸门位置就是 pi-events**——本方案在此修。Codex 的教训是反面：盲重试对确定性截断无效（同 maxTokens 重发同形请求只会再截）——续写指令里 "Break remaining work into smaller pieces" 恰是它缺的那半句。

## 契约

### 层 1 前置｜llm 层原文出口（pi-events 改造——模式 2 的治本）

**原则：截断发生时，下游看到的必须是上游真实交付的原文，不是修补品。**

现状：`toolcall_start`/`toolcall_delta` 分片被丢弃（pi-events.ts:247-249「无工具分片消费者」），`toolcall_end` 单帧出口发 `JSON.stringify(修补后对象)`。

改造：

1. **原文缓冲**：pi-events 内按 contentIndex 缓冲 `toolcall_delta` 的 `delta` 原文拼接（`event.delta`——anthropic 方言即 `partial_json` 分片）。
2. **终态感知出口**：`toolcall_end` 到达时**暂存不立即发**；`done` 事件到达时已知终态（`reason === "length"`）——
   - **截断终态**：对该流内各块，以**缓冲原文**判完整性（`JSON.parse` 成败）：失败的块以**原文本身**（未经 partial-json 修补、未经 re-stringify）作为 `argumentsDelta` 发出；成功的块照旧发 `JSON.stringify(对象)`。
   - **正常终态**：全部照旧（修补产物无损——完整 parse 路径本就等价于原文）。
   - **error 救回路径**（errorChunks 的 max-tokens 救回，OUTPUT-TOKEN-CONTINUATION 契约 3）：同待遇——救回时按截断终态处理。
3. **块序保持**：tool-call-delta 帧的发出次序维持原 contentIndex 序（缓冲不打乱）。

**精确化推论**：截断只可能命中**最后一个 in-flight 块**（前面的块 `content_block_stop` 已到，原文完整）——混合 case 天然精确：完整调用不受牵连照常执行，只有真正半截的那个被标嫌疑。这比「max-tokens ⇒ 全部嫌疑」保守派更准，前面的合法调用不白费。

**效果**：

- 模式 2 被打回模式 1 的检测面——半截 content 到 agent 层时 arguments 是真半截 JSON，下游 `isTruncatedArguments` 可判；
- WAL 落上游真实交付字节（STREAM-PARTIAL-PERSISTENCE 本义回归——修补版落盘是违例）；
- 层 2 提取器输入 = 原文（转义状态真实，提取确定性成立）；
- 正常流零行为变化（完整路径原文 ≡ 修补产物）。

**范围**：仅 anthropic 方言需要（openai 方言的 pi 适配器同样有 partial-json 处理，同法覆盖；实施时以 pi-ai 各 api 文件逐一核对）。

### 层 1｜截断判定与配对收场（agent-loop 内核，工具语义无关）

**完整性判定（纯函数，住 tool-calls.ts）**：

```ts
/** 输出截断的 tool_use 参数判定：input 是 JSON object 串（tool/call 契约）。
 *  "" = 零字符截断；JSON.parse 失败 = 半截；成功（含非 object 的合法 JSON）= 完整
 *  ——非 object 合法 JSON 是模型 bug 不是截断，归既有 TypeBox 违规回显自纠路径。
 *  前置契约：层 1 前置保证截断块到达时即原文（未经 pi-ai partial-json 修补）——
 *  本判定才可依赖 JSON.parse 失败。 */
function isTruncatedArguments(input: string): boolean {
  if (input === "") return true;
  try { JSON.parse(input); return false; } catch { return true; }
}
```

**应用点 = `scheduleTools`（step.ts）一处收口**：`assistant.stopReason === "max-tokens"` 时对 specs 分区——

- **截断集**：逐个 append `tool/call`（arguments 原文——半截 JSON 落卷保审计）+ `tool/result{isError, content: TRUNCATED_TOOL_MESSAGE}`。**不 dispatch**。配对先例 = `denyNotAllowed`（tool-calls.ts:56-62）；repair.ts 的 `danglingToolClosers` 见 tool/result 已应答不再合成误导 closer。
- **执行集**：完整调用照常 `executeToolCalls`。
- 执行集空且截断集非空 → `return { kind: "none" }` → **收束窗口自然可达** → 既有 agent-continuation 插件零改动接手（`decideContinuation` 对 content 含 tool_use 的 max-tokens settle 正常判续——policy.ts 只挡零内容）。

**关键正确性约束**：`assistant/message` 落账在前，半截 tool_use 已在卷上、已进投影——Anthropic 协议要求每个 tool_use 必须紧跟 tool_result。**只剔除不配对，续写请求就是非法形状直接 400**。故必须合成配对结果。

**投影时序（全截断 + 续写成功路径）**：

```
assistant/message{content:[text?, tool_use(半截)], stopReason:"max-tokens"}
tool/call{arguments: 半截 JSON 原文}
tool/result{isError, content: 截断说明 + 抢救附注(层2)}
agent/message{source:"output-continuation", kind:"directive"}   ← 续写指令
（续写步请求 = 上述全部投影，末条为指令——协议合法）
```

**混合 case（同响应有完整调用 + 截断调用）**：完整照常执行，截断的合成配对错误，`flow.kind === "ran"` 走正常工具流 → 现行粘性 max-tokens 收轮（**不变**——完整工具结果待消化，注入续写指令会打架；与 ZCode `toolCallCount > 0 → none` 同判）。

**无插件装配时**：行为从「执行半截→违规回显或静默损坏→粘性收轮」变为「合成配对错误→粘性收轮」，终态相同、WAL 更诚实。

**文案常量**：

```
TRUNCATED_TOOL_MESSAGE = "arguments truncated by output token limit — call not executed. Re-issue the call; for large file writes, split the content into smaller pieces."
```

### 层 1.5｜抢救窗口（新 waterfall 词条，内核零工具语义）

```ts
/** tokens.ts 新增（agentRequestError 同款形状：载荷 → 可选决策） */
export const agentTruncatedTool = defineWaterfall<
  { session, turn, step, callId, name, arguments },   // 纯事实载荷
  { note: string } | undefined                         // 抢救附注（嵌进合成 result）
>("agent/truncated-tool");
```

- 派发点：截断集逐个配对**之前**；插件在此做副作用（层 2 写 sidecar）并返回 `note`。
- 合成 result 的 content = `TRUNCATED_TOOL_MESSAGE` +（note 在场 ? `"\n" + note` : `""`）。
- 形状门在内核（note 非空串；垃圾 → 忽略附注走 base 文案——比 fail-loud 收轮温和，抢救是增益不是契约）。**裁决点⑥**。

### 层 2｜write 半截产出抢救（插件，住 packages/tool-write）

**提取器（纯函数，~40 行，v1 只认 write 的 `content` 字段）**：

- 定位 `"content"` 键：`/"content"\s*:\s*"/` 找到值起始引号；找不到（截断在 content 之前）→ 无可抢救。
- 从起始引号逐字符扫描，按 JSON 转义规则解码（`\"` `\\` `\n` `\t` `\uXXXX`…）——转义状态局部成立，截断点前的前缀解码是**确定性**的；扫描终止于（a）未转义闭合引号 → content 完整（截断发生在更后的键，仍抢救）或（b）输入耗尽 → 半截 content 前缀。
- 同法提取 `"path"`；**path 不完整 → 无法命名目标 → 跳过抢救**（note 说明 target 不可知）。
- 边界：`\uXX` 截在中间 → 丢弃该不完整转义序列（保守丢 ≤5 字符，不猜）。
- 前置依赖：输入是层 1 前置发出的**原文**（转义状态真实）——修补版无法可靠提取（partial-json 闭合引号后字符串边界已失真）。

**物化**：解码出的前缀写 sidecar `<target>.partial`（同目录）。经 ExecEnv `writeFileAtomic`（装配面既有依赖）。目标文件本身**不动**——write 是覆盖语义，写一半即破坏现场（模式 2 现状正是干了这个）。

**note 文案**：

```
Recovered ${chars} chars (${lines} lines) of the truncated write to ${target}.partial (draft — ${target} NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.
```

**无抢救价值时**（提取失败）：插件让位（undefined），只有 base 文案。

**架构位置**：`createTruncatedWriteRescuePlugin(): Plugin`，inject ExecEnv；与 `createWriteTool` 同包不同文件。harness 装配面 +1 行。与 agent-continuation 同构：策略归插件、内核零工具语义。

### 层 0｜上游旋钮

- **0a**：核对 GLM-5.3 真实输出上限 ≥ 34k；有空间则调 preset（host-hub shared/presets.ts）。`DEFAULT_MAX_TOKENS = 8192` **不动**（全局兜底抬高对低上限 provider 是 400 风暴）。
- **0b（接线断口修复）**：`CatalogEntry.maxTokens`（模型级 meta + `modelOverrides`）进请求。链路：`buildAssemblySnapshot` 增 `maxOutputTokensByModel`（从 entries 取）→ `AssemblyProvider` 扩形 → worker `buildAdapters` 透传 → pi-adapter `AdapterCoreOptions` 增 `maxOutputTokensByModel?: Record<string, number>`，折叠序 `request.maxTokens ?? byModel[request.model] ?? core.maxOutputTokens ?? DEFAULT`（anthropic 协议链末端兜底不变）。CLI 面不受影响（其 providers.json 模型是裸 id 无元数据）。

## 不变量与裁决点

| # | 决策 | 本方案立场 |
|---|---|---|
| ① | 半截 tool_use 的落账归宿 | **保留在 assistant/message**（与 ZCode 丢弃相反）——resume/审计/配对三重语义依赖；模型回传面靠合成 result 纠正认知 |
| ② | 混合 case 是否进续写 | 不进（现行粘性保持）——完整工具结果待消化 vs 续写指令打架 |
| ③ | sidecar 落点 | `<target>.partial` 同目录（workspace 内 read 可达——agentDir 在 workspace 外 read 够不着，这是硬约束不是偏好）。不自动清扫（误删风险 > 残留垃圾），note 指令要求模型用后删 |
| ④ | 完整性判据 | **基于原文的 JSON.parse**——层 1 前置（pi-events 原文出口）是本判据的前置契约：截断块到达 agent 层时必为原文。非 object 合法 JSON = 完整，归模型 bug 路径。（原案「JSON.parse 失败 = 截断」在 pi-ai 修补链路上永不触发——本条已随发现改判） |
| ⑤ | 抢救范围 | v1 只 write（content 单字符串提取器）；edit（old_string/new_string 对）与 bash heredoc 挂账 |
| ⑥ | 垃圾 note 的处置 | 忽略附注走 base（温和）vs fail-loud 收轮——倾向温和，抢救是增益非契约 |
| ⑦ | pi-events 出口行为 | 截断终态发原文、正常终态发修补产物（两者在完整路径等价）——不是「永远发原文」：正常路径 re-stringify 无害且保持既有 chunk 形状稳定 |

**不受动的面**：`settleAssistant` 中间件、`parseArgs` 原文回显、agent-continuation 包、repair.ts、`stop` 终态的 TypeBox 自纠路径（那是模型 bug 不是截断）。

## 问题域

- 处理：pi-events 原文缓冲与终态感知出口（层 1 前置）+ 截断判定谓词 + scheduleTools 分区 + 配对合成 + `agentTruncatedTool` waterfall 词条 + write content 提取器 + sidecar 物化插件 + hub 目录 maxOutputTokens 接线 + GLM preset 核对。
- 不处理（归属）：
  - edit/bash 半截抢救——第二消费者出现再做（提取器接口按单字符串字段设计，扩展点明确）；
  - 通用 partial-JSON 库——v1 专用提取器（`"content":"` 定位 + 逐字符反转义），通用化等需求出现再抽（pi-ai 内部的 partial-json 是它的私产，不外借语义）；
  - `DEFAULT_MAX_TOKENS` 全局兜底值——不动（低上限 provider 400 风暴）；
  - 续参数拼接（模型只输出剩余半截、harness 拼接执行）——不可行且不做：工具参数是协议结构化输出，模型没有被训练过「以纯文本续写上一轮参数 JSON 片段」；拼接点在 JSON 字符串中间（转义状态/引号闭合）逐字符精确接上不可靠；工业实践一致丢弃/重试（ZCode 四闸门、Codex 协议保证丢弃），无人做拼接——可靠性过不了；
  - Codex 式盲重试（截断折成可重试流错误原样重发）——已否决：确定性截断重发同形请求只会再截，续写指令的拆分引导才是缺失的半句；
  - `.partial` 自动清扫——挂会话收尾 sweep 曾被考虑，误删风险 > 残留垃圾，改为 note 指令要求模型用后删。

## 并发/一致性预算

- pi-events 原文缓冲是流消费局部状态（单消费者迭代内），无并发面。
- scheduleTools 分区在工具排他屏障内（既有串行面），无新并发。
- 插件写 sidecar 经 ExecEnv（与 write 工具同一原子写通道），崩溃窗口 = sidecar 已写而 note 未落账 → 模型只看到 base 文案、`.partial` 成孤儿文件——无害（下次事故覆盖同名）。
- `agentTruncatedTool` waterfall 派发在配对之前、同 step 内串行——无竞态面。

## 测试口径

**llm 层（新增——层 1 前置）**：

- 原文缓冲：delta 分片拼接正确；多块（contentIndex）互不串扰。
- 终态感知：`done{length}` 且块原文 parse 失败 → 发原文；块原文完整 → 发 stringify（正常路径）；`done{stop}` → 全部照旧（回归钉死）。
- error 救回路径同待遇（errorChunks 救回 + 半截块 → 原文）。
- 块序：发出的 tool-call-delta 帧按 contentIndex 序。
- 模式 2 回归：截断在 content 中途 → arguments 到达态 = 真半截（不再是修补版合法对象）。

**agent-loop 层**：

- 判定谓词：`""` / 半截 / 完整 / 非 object 合法 JSON。
- 分区：全截断（→ none + 配对事件序）／混合（→ ran + 配对；完整调用不受牵连）／全完整 max-tokens（→ ran 不变）。
- 续写集成：全截断 + continuation 插件 → resume、指令落卷、投影末条为指令。
- gate：合成 result 过 `tool/result` 门（isError 可选，形状兼容）。

**层 2**：

- 提取器：content 半截／path 半截／无 content 键／content 完整但后键截断／转义边界（`\u` 半截）。
- note 管道：插件让位（无 note）→ base 文案；插件返回 note → 拼接。

**e2e（script adapter）**：脚本化 max-tokens finish + 半截 tool-call delta → 全路径（含 sidecar 物化断言）。

**回归**：tool-not-allowed 配对用例、OUTPUT-TOKEN-CONTINUATION 既有事件时序用例、pi-events 既有出口用例（正常流 chunk 形状不变）。

## 拆分与实施顺序

1. **批 0**（纯配置/接线）：0a 核对 + 0b 断口修复 + 用例。
2. **批 1a**（层 1 前置，**P0——模式 2 静默损坏的治本**）：pi-events 原文缓冲 + 终态感知出口 + llm 层用例。批 1a 独立可交付：落账从此是真原文，模式 2 退化为模式 1（可检测的违规回显）。
3. **批 1b**（层 1）：判定谓词 + 分区 + 配对 + `agentTruncatedTool` 词条 + 用例（依赖批 1a 的原文保证）。
4. **批 2**（层 2）：提取器 + rescue 插件 + note 管道 + 装配 + 用例。
5. **批 3**：文档同步（本文定稿 + OUTPUT-TOKEN-CONTINUATION 关联节 + AGENT-LOOP-DRIVER §1.5 + LLM-PI pi-events 出口契约）。

无迁移面（新事件向前安全；既有行为变化：① 半截调用不再 dispatch、② 截断时 WAL 落原文而非修补版、③ pi-events 出口对截断流发原文）。

## 成本收益（大 write 34k 截断 case，输出 token 计）

| 路径 | 输出成本 | 结果 |
|---|---|---|
| 现状·模式 1 | 34k 烧掉 + 全重写 34k = 68k+ | 终止、人工重启、模型失忆 |
| 现状·模式 2 | 34k 烧掉 + 全重写（或未察觉） | **静默损坏文件**——最坏 case 无任何信号 |
| 仅层 0 | 截断概率大降；仍截断时同现状 | — |
| 层 0+1 | 同上，但收场正确（续写指令引导拆分）；模式 2 消失 | 拆 N 段整文件重写税 ~1.5x–2x |
| 层 0+1+2 | 34k 已物化 → read 回（输入侧、可 cache）+ 补 17k ≈ **51k** | 等于理论极限，全用模型可靠原语 |
