# 截断 tool_use 识别与半截产出抢救方案

> 状态：**已实施（四批落地 + 三轮对抗审查处置完毕）**——全部 8 项裁决闭合（裁决表）；实施轮三份对抗审查（正确性/安全/测试质量）的关键修正已回写正文（层 1 前置 2-4「end 即放行」、层 2「双层授权面」——附录 A）
> 关联：docs/OUTPUT-TOKEN-CONTINUATION.md（截断续写——本件补其「tool_use 在场」缺口）；docs/STREAM-PARTIAL-PERSISTENCE.md（上游已交付数据不丢弃——本件修其一处违例）；docs/AGENT-LOOP-DRIVER.md §1.5；docs/LLM-PI.md（pi-events 出口契约）；docs/PROVIDER-MAX-OUTPUT-TOKENS.md（0b 接线同源）
> 级别：中偏高（llm 层 pi-events 出口改造 + agent-loop 内核收口 + 新 waterfall 词条 + tool-write/tool-edit 侧插件 + hub 目录接线修复 + dispatch 回显截断）
> 来源：事故——大文件 write 在 arguments 中途撞输出 token 上限；深挖 pi-ai 源码发现更严重的**静默数据损坏**（模式 2a）。

## 问题定义

模型响应因输出上限截断、且截断点落在 tool call 的 arguments 中途。按截断位置分四模式：

### 事故模式表

| 模式 | 截断位置 | arguments 到达 agent 层的形态 | 后果 | 严重度 |
|---|---|---|---|---|
| 1 | arguments 刚起步（`{"` 之前或附近） | `{}`（pi-ai 修补产物） | TypeBox 违规回显 → 模型全量重试再撞墙；带工具粘性 max-tokens 收轮终止 | 中（已观察事故） |
| **2a** | **content 字符串中途（无裸控制字符）** | **`{"path":"foo.ts","content":"半截…"}`——合法 JSON，TypeBox 校验通过** | **write 照常执行，半截文件静默落盘，返回 "Wrote foo.ts (N lines)" 成功回显——模型认为交付成功。无任何错误信号。静默数据损坏** | **P0** |
| 2b | content 中途且含裸控制字符（真实换行等） | `{"path":"foo.ts"}`——修补链**整个丢弃 content 键**（repairJson 转义裸控制符后 partial-json 放弃该成员——审查 A 实测确认） | 表现为模式 1（缺 content 键 → TypeBox 违规可检测）；提取器须与丢键行为对齐 | 中（可检测子形态） |
| 3 | content 之后（后续键中途） | 合法对象缺后继键 | 多数工具照常执行（缺省参数语义）；基本无害 | 低 |

### 根因链（两层 + 外围 + 浪费）

**根因 A｜pi-ai 在 llm 层把半截 JSON 修补成合法对象（模式 2a 成因）**：pi 适配器对 tool_use 参数流式累积时调用 `parseStreamingJson`（anthropic-messages.js:502-503,540-557；openai-completions.js:277,455-456；实现 utils/json-parse.js）：完整 parse 失败 → `repairJson`（转义修复）→ **partial-json 库容错闭合** → `{}` 四级降级。x-harness 的 `toolCallChunks`（packages/llm/src/pi-events.ts:98-110）拿到修补对象再 `JSON.stringify` 下发。后果：

- 下游一切「JSON.parse 失败 = 截断」检测在该链路上**永不触发**；
- WAL `assistant/message` 落修补版而非上游真实交付——「看似完整实则半截」的 content 入卷，resume/replay 被骗（违 STREAM-PARTIAL-PERSISTENCE 本义）；
- 模式 2a 下 TypeBox 无法拦截（形状合法）——损坏直达磁盘。

**方言覆盖**（审查 A 核实的精确清单）：已装配的 anthropic-messages 与 openai-completions 都有该修补；未装配方言（bedrock-converse-stream.js:456,552、mistral-conversations.js:546,561、openai-responses-shared.js:549,558,609、pi-messages.js:159）接入时同查。

**根因 B｜x-harness 无截断 tool_use 的识别与收场机制**：纯文本截断有续写机制（OUTPUT-TOKEN-CONTINUATION），带工具截断对收束窗口**结构性不可达**（窗口只在 `tools.kind === "none"` 可达——「有工具不续」是设计裁决）；半截调用照常调度，错误（模式 1/2b）或成功（模式 2a）回显都不含「截断」事实，无拆分引导。

**外围（层 0）**：GLM preset `maxOutputTokens: 34_000` 可能低于真实上限；hub 目录**接线断口**——模型级 meta `maxTokens` 与 `modelOverrides.<key>.maxOutputTokens` 只进 `CatalogEntry` 展示面（get_models/contextWindow 解析用），不进请求体（`buildAssemblySnapshot` 只取 profile 级，shared/catalog.ts:156-174；`WorkerModelMeta` 类型无 maxTokens 字段，host.ts:94-105 / worker-catalog.ts:15-20；buildAdapters 只消费 profile 级，assembly.ts:144-163——审查 A 全链核实）——**模型级/override 级输出上限配置了也不生效**。

**层 2｜浪费**：write 的 content 只存在于半截参数里——WAL 是修补版（根因 A）、磁盘无物化、模型不可见。大 write 34k 截断 case：理论最优 ≈ 51k 输出（34k 已烧 + 17k 补写），现状 68k+（全重写）且模式 1 需人工重启。

### 三家实现对照（行为分叉根因）

| | Codex | ZCode | x-harness 现状 |
|---|---|---|---|
| 截断信号 | `response.incomplete` 折成可重试流错误，**盲重试原请求** | 归一 `length` → 续写指令（3 次上限） | 归一 `max-tokens` → 续写（仅无工具） |
| 半截 tool_use | 不物化——**协议保证**（Responses API 截断不发 `output_item.done`） | 不物化——**双闸门**（执行参数只认 final tool_call 事件；有 start 无 end 的 final 判不可信丢弃） | **物化且执行**——pi-ai 修补后形状合法，模式 2a 直达磁盘 |
| 参数烂 JSON | RespondToModel 自纠 | 降 `{}` → schema error result | TypeBox 回显自纠（仅对未被修补的） |
| 输出上限配置 | 不设，吃服务端默认 | 每轮打满模型声明上限 | preset/profile + 断口 |

（注：ZCode/Codex 两列为外部系统按当时源码观察，未经本轮复核。）

关键定位：**ZCode 的闸门在 adapter 层（AI SDK 流事件生命周期）；x-harness 的等价闸门位置就是 pi-events**——本方案在此修。Codex 的教训是反面：盲重试对确定性截断无效（同 maxTokens 重发同形请求只会再截）——续写指令里 "Break remaining work into smaller pieces" 恰是它缺的那半句。

## 契约

### 层 1 前置｜llm 层原文出口（pi-events 改造——模式 2a 的治本）

**原则：截断发生时，下游看到的必须是上游真实交付的原文，不是修补品。**

现状：`toolcall_start`/`toolcall_delta` 分片被丢弃（pi-events.ts:247-249「无工具分片消费者」），`toolcall_end` 单帧出口发 `JSON.stringify(修补后对象)`。

改造：

1. **原文缓冲**：pi-events 内按 contentIndex 缓冲 `toolcall_delta` 的 `delta` 原文拼接（`event.delta`——anthropic 方言即 `partial_json` 分片）。**缓冲与暂存队列是 generator 局部状态**（每次 piChunks 调用新建——attempt 循环每次新流新实例，防跨 attempt 泄漏）。
2. **end 即放行（对抗审查 A 1A/1B 修正——原「暂存到终态」设计已否决）**：`toolcall_end` 到达时**立即以缓冲原文判完整性并放行**——`JSON.parse` 失败的块以**原文本身**（未经 partial-json 修补、未经 re-stringify）作为 `argumentsDelta` 发出；成功的块照旧发 `JSON.stringify(对象)`；`raw === ""`（零字符截断）原样发空串（**不得折成 `"{}"`**——下游 `isTruncatedArguments("")` 命中截断分支，折成 `"{}"` 会让空参工具真实执行）。判定只依赖该块自己的缓冲原文（end = 该块分片终点，缓冲已齐），**不依赖流终态**——原「暂存到 done」的设计会让「end 已到、终态未到」窗口内的块随消费侧 fire-and-forget `return()` 蒸发（attempt.ts drainGuarded 的 abort/看门狗路径），是行为回归。帧序与改造前一致（tool-call-delta 在 usage/finish 之前）。
3. **终态合成义务（无 end 块的兜底）**：done / error / catch 路径在发终态帧前对「有 `toolcall_start` 身份 + 有原文缓冲 + 无 end」的块**直接合成** tool-call-delta 帧（`emitted` 集幂等，合成不晚于 finish——头注「done/error 后停发」）：
   - **openai-completions error 救回**（OUTPUT_LIMIT_RAW_REASONS）：`finish_reason:"max_tokens"` 走 throw 前 `finishBlock` 已对全部块跑过 → `toolcall_end` 已 push → end 即放行覆盖，「同待遇」**成立**。
   - **anthropic-messages error 路径**：error 事件是异常路径（stopReason error → throw → catch `:628`）；截断的 in-flight 块**没有 toolcall_end**（content_block_stop 未到），且 pi 侧 catch `:622-624` 已 `delete block.partialJson`——从 `toolcall_start` 身份（partial.content[contentIndex] 累积块——id/name 在 content_block_start 已定）+ 原文缓冲**直接合成**，不依赖 toolcall_end。零字符原文不合成（无内容可救——不造无主帧）。
   - **abort / 非救回 error / 看门狗超时**：end 已放行的块零丢失（无暂存窗口）；in-flight 无 end 块经 catch/finally 的合成兜底尽力送达（消费侧弃单守卫丢弃属既有语义）。interrupted message 结算的 tool_use 落账面保持。
4. **块序**：end 即放行保持事件到达序；合成帧（无 end 兜底）按 contentIndex 升序。

**精确化推论**：截断只可能命中**最后一个 in-flight 块**（前面的块 `content_block_stop` 已到，原文完整）——混合 case 天然精确：完整调用不受牵连照常执行，只有真正半截的那个被标嫌疑。

**已知盲区（记档不修）**：pi-ai 若因网络重放重发 delta 分片，原文缓冲会双拼——`JSON.parse` 判定大概率误标「截断」。方向无害（误标走配对收场不执行）。

**观察面保护（审查 A 新发现④）**：hub 实时预览（apps/host-hub/src/worker/event-bridge.ts:338-349）按帧消费 `argumentsDelta` 拼 `toolInput` 发 `inflight.partial`——出口改造不得使该面从「流式可见」退化为「终态一次可见」；缓冲只改**终态帧的内容**（原文 vs 修补版），不改正常流的帧时序。

**效果**：

- 模式 2a 被打回模式 1 的检测面——半截 content 到 agent 层时 arguments 是真半截 JSON，下游 `isTruncatedArguments` 可判；
- WAL 落上游真实交付字节（STREAM-PARTIAL-PERSISTENCE 本义回归）；
- 层 2 提取器输入 = 原文（转义状态真实，提取确定性成立）；
- 正常流零行为变化（完整路径原文 ≡ 修补产物）。

**范围**：anthropic-messages 与 openai-completions 两条已装配方言（见根因 A 精确清单）；未装配方言接入时同查。

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

- **截断集**：逐个先经 `agentTruncatedTool` 窗口（层 1.5），再 append `tool/call`（arguments 原文；**非 surface 通道**——`mustAppend`）+ `tool/result{isError, content: 文案+附注}`（**必须 surface 通道**——`mustAppendSurface`，surfaceOp:"append"——否则投影缺 tool 消息、配对失效）。**不 dispatch**。配对先例 = `denyNotAllowed`（tool-calls.ts:56-62，两通道形状同款）；repair.ts 的 `danglingToolClosers` 见 tool/result 已应答不再合成误导 closer。
- **执行集**：完整调用照常 `executeToolCalls`。
- 执行集空且截断集非空 → `return { kind: "none" }` → **收束窗口自然可达**（driver.ts:137→142）→ 既有 agent-continuation 插件零改动接手（`decideContinuation` 只挡零内容——含半截 tool_use 块的 content 非空，判续成立）。

**配对合成的动机（修正原「直接 400」表述——审查 A 4a 核实）**：裸 Anthropic 协议要求 tool_use 配对 tool_result，但本链上 pi-ai `transformMessages`（transform-messages.js:130-145）会为孤儿 toolCall 合成 `"No result provided"` isError 兜底——**不会 400**。配对合成的动机是**语义正确**（截断说明 + 抢救附注 vs 通用兜底文案）与**不依赖上游兜底的脆弱契约**，不是形状合法性。

**投影时序（全截断 + 续写成功路径）**：

```
assistant/message{content:[text?, tool_use(半截)], stopReason:"max-tokens"}
tool/call{arguments: 半截 JSON 原文}                    （非 surface）
tool/result{isError, content: 截断说明 + 抢救附注(层2)}  （surface append）
agent/message{source:"output-continuation", kind:"directive"}   ← 续写指令
（续写步请求 = 上述全部投影，末条为指令——协议合法；合法性由配对合成保证语义、pi transformMessages 保底形状）
```

**混合 case（同响应有完整调用 + 截断调用）**：完整照常执行，截断的合成配对错误，`flow.kind === "ran"` 走正常工具流 → 现行粘性 max-tokens 收轮（**不变**——完整工具结果待消化，注入续写指令会打架；与 ZCode `toolCallCount > 0 → none` 同判）。

**无插件装配时**：行为从「执行半截→违规回显或静默损坏→粘性收轮」变为「合成配对错误→粘性收轮」，终态相同、WAL 更诚实。

**投影面已知代价（落档）**：投影回传链 `parseToolInput`（pi-context.ts:14-24）对半截原文 parse 失败**降 `{}`**——**模型在续写请求里看到的自己的 tool_use 参数是 `{}`，不是原文**。原文落账的收益只及于审计/resume/层 2 提取，不及于模型视野。故文案承担解释义务（见下）。改投影发原文会引入半截 JSON 进 wire 的风险，维持 `{}` 降级是正确取舍——落档为裁决⑦。

**文案常量**：

```
TRUNCATED_TOOL_MESSAGE = "arguments truncated by output token limit — call not executed. The arguments echoed in your tool_use above are NOT shown faithfully (truncated/may render as {}); do not treat them as the full payload you sent. Re-issue the call; for large file writes, split the content into smaller pieces."
```

**合成结果标记（裁决⑧——生产可辨）**：合成 tool/result 增可选字段 `synthetic: true`（gate 校验：在场必须 true 布尔；缺席 = 真实执行结果——加字段向前安全）。resume/审计/遥测面上机器可辨，不靠 content 前缀反推。hub 遥测 `tool_result.synthetic` 计数上报（截断事故率可观测——运营面需要，否则修复效果不可度量）。

**批 1a 违规回显截断（批 1a 必含）**：`formatArgsEcho`（core/tools/src/validate.ts:62-70）对超长 args 全量回显——批 1a 落地后 34k 半截原文会逐字符进 tool/result（仅受 maxToolResultChars 100k 兜底），一次截断 = 34k 已烧 + ~34k 回显税（输入侧）+ 重写 34k，比现状模式 1 更贵且多轮撞墙时复利。修法：`formatArgsEcho` 加超长截断——头 2_000 字符 + `…[N chars truncated]` 尾标（与 maxToolResultChars 同哲学），**并入批 1a**。

### 层 1.5｜抢救窗口（新 waterfall 词条，内核零工具语义）

```ts
/** tokens.ts 新增（agentRequestError 同款形状：载荷 → 可选决策） */
export const agentTruncatedTool = defineWaterfall<
  { session: SessionId; turn: number; step: number; callId: string; name: string; arguments: string },  // 纯事实载荷
  { note: string } | undefined   // 抢救附注（嵌进合成 result）
>("agent/truncated-tool");
```

- 派发点：截断集逐个配对**之前**；插件在此做副作用（层 2 写 sidecar）并返回 `note`。
- 合成 result 的 content = `TRUNCATED_TOOL_MESSAGE` +（note 在场 ? `"\n" + note` : `""`）。
- 形状门在内核（note 非空串；垃圾 → 忽略附注走 base 文案——温和处置，抢救是增益非契约）。
- abort 竞态：派发期间 turn signal 断 → 放弃副作用结果、note 丢弃、照常配对（aborted 全序格盖过）。

### 层 2｜半截产出抢救（插件，住 packages/tool-write 与 packages/tool-edit）

**抢救表（v1 覆盖 write + edit——生产主力写路径全兜住）**：

| 工具 | 提取字段 | 提取器 | sidecar 内容 |
|---|---|---|---|
| write | `path` + `content`（单字符串） | 字符串字段提取器 | content 前缀 |
| edit | `path` + `edits[].newText`（数组末条——EDIT-TOOL 落地后的真形态） | `extractLastEditText`（数组感知：末条 newText + path 限定 edits 键前顶层段） | 末条 newText 前缀 |

提取器为**一个**参数化纯函数 `extractStringField(raw: string, field: string): { path?: string; value?: string }`——write 传 `"content"`、edit 传 `"new_string"`，扩展点明确（后续工具加行即入表）。

**提取器规格**：

- 定位目标字段：`/"<field>"\s*:\s*"/` 找到值起始引号；找不到（截断在字段之前）→ 无可抢救。
- 从起始引号逐字符扫描，按 JSON 转义规则解码（`\"` `\\` `\n` `\t` `\uXXXX`…）——转义状态局部成立，截断点前的前缀解码是**确定性**的；扫描终止于（a）未转义闭合引号 → 字段完整（截断发生在更后的键，仍抢救）或（b）输入耗尽 → 半截前缀。
- 同法提取 `"path"`；**path 不完整 → 无法命名目标 → 跳过抢救**（note 说明 target 不可知）。
- 边界：`\uXX` 截在中间 → 丢弃该不完整转义序列（保守丢 ≤5 字符，不猜）；**裸控制字符子形态（模式 2b）**：提取器只吃层 1 前置的原文（裸控制字符在 JSON 字符串里本就非法，正常流模型不会发——出现即截断/坏输出，按原文逐字符扫描自然处理），用例钉死与修补版丢键行为的不一致面。
- 前置依赖：输入是层 1 前置发出的**原文**（转义状态真实）——修补版无法可靠提取（partial-json 闭合引号后字符串边界已失真；模式 2b 下修补版干脆丢键）。
- **体积下限**：提取值 < 512 字符 → 不物化（note 说明 `too short to be worth a draft`）——微型半截不值得一次 read 往返。

**物化（双层授权面——审查 B P0① + 实施轮加固）**：sidecar 写入**必须过与 write 工具同源的双层授权面**，不得走裸 `env.writeFileAtomic`——`path` 是从模型半截参数提取的**未经校验的模型产物**，裸写即绕过越根/`../` 穿越/permission/deny 规则/plan-deny/protectedPaths 全部授权面（恶意/抽风模型可**主动制造截断**把「deny 的 X 写不进去」降级成「X.partial 随便写」）：

1. **PathGate 层**：`admitSession(gate, realpath, session, extraRootsOf, rootOverrideOf, target: path + ".partial")`——**后缀拼接在门判定之前**，对最终 sidecar 路径整体过门（词法+物理双查）。拒绝 → 跳过物化，note 说明 `target outside workspace boundary, draft not saved`。
2. **permission 层**：`decideFor` 纯函数以 `tool: "write"`、`args.path = admitted.path`（realpath 归一回裁决树——macOS `/var` symlink 前缀差异会使 globMatch 失配）同源裁决：deny 规则/plan-deny 硬闸/protectedPaths/ask 档全部生效；非 allow → note 说明 `target not permitted for rescue write, draft not saved`（**ask 档不弹窗直接不救**——抢救是增益非契约，模型重发完整调用走正常面板）。规则集/档位/围栏事实经 `permissionGrants`/`permissionMode`/`fenceFacts` 服务令牌运行期消费（插件 tryUse——装配序 permission 件先于抢救件）；**无 permission 装配的世界不物化**（无裁决面即无写盘授权）。装配面：`toolboxKit` 增可选 `permission` 面（root/rules/projectRules/protectedWrite），两宿主与 `fenceKit` 同源接线（hub 保护路径透传 protectedWrite、CLI 用户规则单点解析）。
3. 通过 → `env.writeFileAtomic(admittedPath, …)`。**不登记 ObservedRegistry**（sidecar 不是观察-写流程，不参与版本 CAS）；**不覆盖已存在文件**——`stat(admittedPath)` 命中已存在文件即拒绝物化（note 说明 `draft exists, not overwritten`）：`<target>.partial` 可能是目标文件的有意命名（模型/用户先例），抢救物化静默覆盖它是数据丢失通道，宁可放弃抢救。目标文件本身**不动**——write 覆盖语义写一半即破坏现场（模式 2a 现状正是干了这个）。`path === ""` 让位（空目标名不可救）。

**note 文案（write）**：

```
Recovered ${chars} chars (${lines} lines) of the truncated write to ${target}.partial (draft — ${target} NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.
```

**note 文案（edit）**：

```
Recovered ${chars} chars of the truncated edit's new_string to ${target}.partial (draft — ${target} NOT modified). Read it, re-issue the edit with the replacement text in smaller pieces, then delete the .partial.
```

**无抢救价值时**（提取失败/门拒绝/体积下限/已存在拒绝）：插件让位或降级 note，只有 base 文案。

**架构位置**：`createTruncatedWriteRescuePlugin(): Plugin`（覆盖 write+edit 两工具的词条消费者），inject `gate/observed/env`；住 packages/tool-write。harness 装配面 +1 行（三件套与 write 工具同源注入）。与 agent-continuation 同构：策略归插件、内核零工具语义。bash heredoc 挂账（v2——bash 参数是自由文本 shell 脚本，无 JSON 字段结构，提取器形态不同，等独立需求）。

### 层 0｜上游旋钮

- **0a**：核对 GLM-5.3 真实输出上限 ≥ 34k；有空间则调 preset（host-hub shared/presets.ts）。**本地兜底 `DEFAULT_MAX_TOKENS = 8192` 已废除**（实施后用户裁决）：折叠链全缺席 → 不注入，wire 面省略 `max_tokens`——服务端默认接管；本地硬编码会顶掉目录/服务端的真实意图（曾以 8192 顶掉 56000 配置的事故形态即此病）。
- **0b（接线断口修复）**：`CatalogEntry.maxTokens`（模型级 meta + `modelOverrides`）进请求。链路：`buildAssemblySnapshot` 增 `maxOutputTokensByModel`（**从 entries 取已解析值——`entryOf` + `applyOverride` 单源，不得重算优先级**，否则与 `get_models` 展示面漂移、`set_model_override` 命令面与请求面两个真相）→ `AssemblyProvider` 扩形 → worker `buildAdapters` 透传 → pi-adapter `AdapterCoreOptions` 增 `maxOutputTokensByModel?: Record<string, number>`，折叠序 `request.maxTokens ?? byModel[request.model] ?? core.maxOutputTokens ?? DEFAULT`（anthropic 协议链末端兜底不变）。CLI 面不受影响（其 providers.json 模型是裸 id 无元数据）。

## 不变量与裁决点（全部已闭合）

| # | 决策 | 定稿裁决 |
|---|---|---|
| ① | 半截 tool_use 的落账归宿 | **保留在 assistant/message**（与 ZCode 丢弃相反）——resume/审计/配对三重语义依赖；模型回传面靠合成 result 纠正认知 |
| ② | 混合 case 是否进续写 | 不进（现行粘性保持）——完整工具结果待消化 vs 续写指令打架 |
| ③ | sidecar 落点与生命周期 | `<target>.partial` 同目录（workspace 内 read 可达——agentDir 在 workspace 外是硬约束）。不自动清扫；**不覆盖已存在的 `.partial`**（数据丢失通道）；note 指令要求模型用后删 |
| ④ | 完整性判据 | **基于原文的 JSON.parse**——层 1 前置是前置契约：截断块到达 agent 层时必为原文。非 object 合法 JSON = 完整，归模型 bug 路径 |
| ⑤ | 抢救范围 | **v1 = write（content）+ edit（new_string）**——两工具共用一个参数化提取器；bash heredoc 挂 v2（自由文本形态不同） |
| ⑥ | 垃圾 note 的处置 | 忽略附注走 base（温和）——抢救是增益非契约，fail-loud 会把插件 bug 放大成收轮事故 |
| ⑦ | pi-events 出口行为 | 截断终态发原文、正常终态发修补产物（完整路径语义等价）。**已知代价：投影面 parseToolInput 降 `{}`，模型看不到自己半截参数原文**——原文收益及审计/resume/层 2，模型认知靠文案纠正（已写入 TRUNCATED_TOOL_MESSAGE） |
| ⑧ | 合成 result 标记 | **加 `synthetic: true` 可选字段**（gate 收编；缺席 = 真实结果，加字段向前安全）——生产可辨 + 遥测计数上报（截断事故率可观测） |

**不受动的面**：`settleAssistant` 中间件、`parseArgs` 原文回显、agent-continuation 包、repair.ts、`stop` 终态的 TypeBox 自纠路径（那是模型 bug 不是截断）。

## 配置面

全部走既有通道，**零新配置键**（生产默认全开、无需用户调参）：

- `maxOutputContinuations`（既有，缺省 3）——截断续写次数，含本件新接续的全截断 case；
- sidecar 抢救无开关——授权面拒绝时自然降级（note 说明），无静默配置面；
- `formatArgsEcho` 截断阈值（2_000）与体积下限（512）为代码常量——稳定语义不进配置面。

## 问题域

- 处理：pi-events 原文缓冲与全终态感知出口（含分方言 error 救回）+ 截断判定谓词 + scheduleTools 分区 + 配对合成（双通道 + synthetic 标记）+ `agentTruncatedTool` waterfall 词条 + 参数化字符串提取器（write/edit）+ sidecar 物化插件（含授权面）+ `formatArgsEcho` 超长截断 + hub 目录 maxOutputTokens 接线（单源）+ GLM preset 核对 + 遥测计数。
- 不处理（归属）：
  - bash heredoc 半截抢救——v2（自由文本形态，提取器结构不同，等独立需求）；
  - 通用 partial-JSON 库——参数化单字段提取器已覆盖 v1 表；通用化等第三个消费者出现再抽；
  - ~~`DEFAULT_MAX_TOKENS` 全局兜底值~~——已废除（全缺席不注入，服务端默认接管；400 风暴论证失效：服务端默认本就是 provider 自己的合法值）；
  - 续参数拼接（模型只输出剩余半截、harness 拼接执行）——不可行且不做：工具参数是协议结构化输出，模型没有被训练过「以纯文本续写上一轮参数 JSON 片段」；拼接点在 JSON 字符串中间（转义状态/引号闭合）逐字符精确接上不可靠；工业实践一致丢弃/重试，无人做拼接；
  - Codex 式盲重试——已否决：确定性截断重发同形请求只会再截；
  - `.partial` 自动清扫——误删风险 > 残留垃圾；模型用后删（note 指令）+ 同名不覆盖兜住损失面；
  - pi-ai delta 重放双拼（层 1 前置已知盲区）——方向无害（误标走配对收场），记档不修；
  - 投影面发原文——半截 JSON 进 wire 的 400 风险，维持 `{}` 降级（裁决⑦）。

## 并发/一致性预算

- pi-events 原文缓冲是 generator 局部状态（单消费者迭代内、attempt 级隔离），无并发面。
- scheduleTools 分区在工具排他屏障内（既有串行面），无新并发。
- 插件写 sidecar 经 admitSession + ExecEnv 原子写；崩溃窗口 = sidecar 已写而 note 未落账 → 模型只看到 base 文案、`.partial` 成孤儿文件——无害（不覆盖策略下下次事故不覆盖、note 可引导清理）。
- `agentTruncatedTool` waterfall 派发在配对之前、同 step 内串行——无竞态面；abort 竞态见层 1.5。

## 测试口径

**llm 层（层 1 前置）**：

- 原文缓冲：delta 分片拼接正确；多块（contentIndex）互不串扰；跨 attempt 隔离（新流新实例）。
- 终态感知：`done{length}` 且块原文 parse 失败 → 发原文；块原文完整 → 发 stringify；`done{stop}` → 全部照旧（回归钉死）。
- 全终态 flush：abort throw / 非救回 error / 看门狗超时注入 → 暂存帧不蒸发（interrupted 落账面回归——STREAM-PARTIAL-PERSISTENCE 用例不破）。
- error 救回分方言：openai（toolcall_end 已 push → 放行缓冲）；anthropic（无 toolcall_end → 从 start 身份 + 原文缓冲合成）。
- 块序：发出的 tool-call-delta 帧按 contentIndex 序。
- 模式回归：2a（content 中途 → 真半截到达）；2b（裸控制字符 → 原文照发）。
- hub 观察面：event-bridge inflight.partial 实时预览行为不回退。

**agent-loop 层**：

- 判定谓词：`""` / 半截 / 完整 / 非 object 合法 JSON。
- 分区：全截断（→ none + 配对事件序，含双通道与 synthetic 断言）／混合（→ ran + 配对；完整调用不受牵连）／全完整 max-tokens（→ ran 不变）。
- 续写集成：全截断 + continuation 插件 → resume、指令落卷、投影末条为指令。
- gate：合成 result 过 `tool/result` 门（含 `synthetic: true` 新字段校验；缺席兼容）。
- `formatArgsEcho`：>2k 头 2k + 尾标；≤2k 原样；Symbol/BigInt 路径不破。

**层 2**：

- 提取器（参数化两字段各跑一遍）：字段半截／path 半截／无字段键／字段完整但后键截断／转义边界（`\u` 半截）／裸控制字符子形态／体积下限（<512 不物化）。
- note 管道：让位 → base；note → 拼接；门拒绝/已存在/下限 → 降级 note。
- 授权面：`../` 穿越/越根 → 拒绝 + 降级 note；workspace 内 → 物化；**同名 `.partial` 已存在 → 拒绝覆盖**。

**e2e（script adapter）**：脚本化 max-tokens finish + 半截 tool-call delta → 全路径（sidecar 物化、授权面、续写接续、synthetic 落账断言）。

**回归**：tool-not-allowed 配对、OUTPUT-TOKEN-CONTINUATION 事件时序、pi-events 出口（正常流 chunk 形状不变）、STREAM-PARTIAL-PERSISTENCE interrupted 落账、resume 修复（synthetic 结果不再被 danglingToolClosers 补 closers）。

## 拆分与实施顺序（含验收门）

1. **批 0**（配置/接线）：0a 核对 + 0b 断口修复（单源取 entries）+ 用例。**验收门**：`modelOverrides`/模型级 maxTokens 配置后请求体携带该值（adapter 侧断言）；get_models 展示值与请求值一致（同源）。
2. **批 1a**（层 1 前置，**P0——模式 2a 治本**）：pi-events 原文缓冲 + 全终态感知出口（abort/error/超时 flush + 分方言 error 救回）+ `formatArgsEcho` 超长截断 + llm 层用例。**验收门**：模式 2a 语义测试（content 中途截断 → 到达 agent 层的是真半截 JSON）；interrupted 落账回归全绿。**定位诚实**：只治数据损坏不治可用性（事故 case 仍终止），可用性由批 1b 收。
3. **批 1b**（层 1 + 1.5）：判定谓词 + 分区 + 配对（双通道 + synthetic）+ `agentTruncatedTool` 词条 + agent-loop 用例（依赖批 1a 原文保证）。**验收门**：全截断 → 收束窗口 → 续写接续 e2e；混合 case 完整调用照常执行。
4. **批 2**（层 2）：参数化提取器 + rescue 插件（write/edit，含授权面）+ note 管道 + 装配 + 用例。**验收门**：授权面攻击用例（越根/穿越/同名不覆盖）全绿；两工具 note 文案正确。
5. **批 3**（收口）：文档同步（本文 + OUTPUT-TOKEN-CONTINUATION 关联节 + AGENT-LOOP-DRIVER §1.5 + LLM-PI 出口契约 + AGENT-MESSAGE 无涉确认）+ 遥测计数上报 + e2e 旅程 + 四门（typecheck/lint 0-0/build/test）+ 对抗审查（独立会话对 diff）。

无迁移面（新事件/新字段向前安全；既有行为变化：① 半截调用不再 dispatch、② 截断时 WAL 落原文而非修补版、③ pi-events 出口对截断流发原文、④ 全终态 flush 暂存帧、⑤ 超长 args 回显截断、⑥ 合成 result 携 synthetic 标记）。

## 成本收益（大 write 34k 截断 case，输出 token 计）

| 路径 | 输出成本 | 结果 |
|---|---|---|
| 现状·模式 1 | 34k 烧掉 + 回显~0 + 全重写 34k = 68k+ | 终止、人工重启、模型失忆 |
| 现状·模式 2a | 34k 烧掉 + 全重写（或未察觉） | **静默损坏文件**——最坏 case 无任何信号 |
| 仅层 0 | 截断概率大降；仍截断时同现状 | — |
| 批 1a | 34k 烧掉 + 回显截断后 ~2k + 重写 34k ≈ 70k | 模式 2a 消失（退化为可检测）；可用性仍差 |
| 层 0+1（a+b） | 同上，但收场正确（续写指令引导拆分） | 拆 N 段重写税 ~1.5x–2x |
| 层 0+1+2 | 34k 已物化 → read 回（输入侧、可 cache）+ 补 17k ≈ **51k** | 等于理论极限，全用模型可靠原语 |

## 附录 A｜对抗审查处置记录

- **审查 A（实现事实核查）**：根因 A/B 主链、0a/0b 断口、裁决①⑤原立场、层 2 主链无二次转换——**全部属实**；修正 2 处因果表述（「直接 400」→ pi transformMessages 兜底，配对动机改为语义正确；error 救回「同待遇」→ 分方言——openai 成立 / anthropic 需从 start 身份合成）；4 项新发现（裸控制字符丢键＝模式 2b、0b 单源约束、hub event-bridge 观察面、方言精确清单）——全部并入。
- **审查 B（架构攻击）**：P0×2（sidecar 授权面 → 层 2 物化三件套 + admitSession；全终态 flush 义务 → 层 1 前置 3）；P1×3（abort 出口裁决 → flush 原文判定版；投影 `{}` 断层 → 裁决⑦ + 文案承担解释义务；回显截断 → 批 1a 必含 formatArgsEcho 截断）；P2×2（缓冲生命周期 → generator 局部；合成结果无标记 → 裁决⑧升级为 synthetic 字段）；P3×1（重放双拼 → 记档不修）——全部并入。
- **本稿新增生产化补强**（超两轮审查范围）：抢救表扩 edit（共用参数化提取器）；sidecar 不覆盖已存在文件（数据丢失通道封堵）；体积下限 512（微型半截不物化）；abort 竞态处置（层 1.5）；零新配置键声明；逐批验收门；遥测计数上报（截断事故率可观测）。
