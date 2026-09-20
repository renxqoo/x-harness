# LLM 请求层重构：wire 层换 @earendil-works/pi-ai（参考 my-agent provider-pi）方案

> 状态：已实施（双对抗审查问题全部处置；工具出口改 end 单帧——用户裁决；真凭证验证待用户拍板）
> 级别：中（外部契约不变，包内 wire 实现整体替换 + 新增外部依赖）

## 契约

**不变（下游零改动）**：

1. `LlmChunk` 五变体词表、`LlmFinish`、`LlmRequest`、`LlmAdapter`、`LlmRuntime`（types.ts 原样）。
2. 工厂名与签名：`createAnthropicCompatAdapter` / `createOpenaiCompatAdapter`
   （`{ name?, baseUrl, apiKey, fetch?, maxOutputTokens?, contextWindow?, streamFn? }`——`fetch` 经 pi `options.fetch` 原样透传，
   scene-server 真身测试形态续命）、`llmPlugin`、token、adapter-plugin 工厂。
3. 错误码闭集：`http-<status>` / `network` / `no-adapter` + `retryAfterMs`（llm-retry 依赖面）。
4. usage 折算：pi `Usage` cacheRead+cacheWrite 折入 input；全零不发 usage 帧（守卫保留）。
5. 流帧语义：finish 恰一次；thinking-delta 只透传（落账收集由 agent-loop 承担——docs/STREAM-PARTIAL-PERSISTENCE.md）；请求前已 abort → throw（豁免路径不变）。

**变更（含语义变更落档）**：

1. **调用面（审查 A1/P10 处置）**：不走 `Models.stream`（provider 注册门 + env 鉴权门挡死手配形态）；
   直 import `@earendil-works/pi-ai/api/anthropic-messages` 与 `/api/openai-completions` 的
   `stream(model, context, options)`。options 携带：
   `apiKey`、`headers: { "accept-encoding": "identity" }`（硬化迁移——GLM 攒批根因，审查 B3/P6）、
   `signal`、`maxTokens`、`temperature?`、`fetch?`、**fetch 包装层捕获非 2xx 状态与 retry-after 头**（pi 的 onResponse 只在成功路径触发——SDK 对错误状态在 retryProviderRequest 内即 throw，审查 A1/P3 处置）、
   `cacheRetention: "none"`（保持现 wire 无 cache_control，审查 B4）。
   Model 条目最小构造（`api`/`provider`/`baseUrl`/`maxTokens`/`contextWindow` 必填，
   工厂选项 `contextWindow?` 缺省 200_000）。输出上限折叠：`request.maxTokens ?? maxOutputTokens`；
   anthropic 工厂恒注入 maxTokens（协议必填，链末端 8192）；openai 工厂仅折叠值在场才发
   （请求显式或档案配置；双缺席不发）。
2. 新增三文件：
   - `pi-context.ts`：SurfaceMessage → pi `Context`（system 顶层；user 只取 text 块、空 user 跳过；
     assistant text/tool_use，input STRING→JSON.parse 降 {}；tool 消息→toolResult，toolName 前文
     回查、查无 "unknown"；assistant 重放元数据必填字段补齐（SurfaceMessage 投影无 stopReason，重放恒 stop））。
   - `pi-events.ts`：pi 事件 → `LlmChunk`：
     - `text_start`/`thinking_start` 读 `partial.content[contentIndex]` 非空初值 → 补发 delta（P10 保真，审查 B5）；
     - `text_delta`/`thinking_delta` → 对应 chunk；`toolcall_start` 有身份 → `{index: contentIndex, callId, name}`
       （**语义变更：index 由 wire 原值稀疏变 pi 稠密**——StreamAccumulator 按 index 键聚积，兼容；落档）；
       start/delta 分片不透传——**出口单帧**（用户裁决：pi 的 toolcall_end 已含完整调用，不做工具流处理）；
     - `done` → usage（折算+全零守卫）+ finish（`length`→max-tokens；`toolUse`/`deferred`/未知→stop）；
     - `error` → **先发 usage chunk（error.usage 折算——失败尝试计费保真，审查 A4）**，再按分类发 error finish；
     - **abort 豁免（审查 A3/P1）**：`reason === "aborted"` 或 `request.signal.aborted` →
       `throw new DOMException("aborted", "AbortError")`（不产 error finish）——runtime 归一层豁免路径保持。
   - `pi-adapter.ts`：两工厂（Model 构造 + options 组装 + onResponse 状态/retry-after 捕获 + stream 组装）。
3. **错误分类（审查 B1/P4 处置）**：`onResponse` 捕获真实 `status` → code `http-<status>`（无文案猜测）；
   无 onResponse（连接失败）→ 文案分类：网络词族（timeout/network/fetch failed/econnrefused）→ `network`；
   **refusal/sensitive/content_filter → 无 code error finish（不可重试——与现 refusal 行为一致）**；
   文案含状态码时按词边界正则（`(?:^|[^0-9])N(?:[^0-9]|$)`，负例 `14290`≠`429` 全表驱动）。
   `retryAfterMs`：onResponse 头 `retry-after`/`retry-after-ms`（秒小数 + HTTP-date + 过去=0，
   parseRetryAfterMs 随 http-dial 迁入 pi-adapter 复用）——**头捕获替代文案解析**。
4. 删除五 wire 文件（http-dial/sse-scan/anthropic-request/anthropic-compat/openai-compat）及其直测；
   `adapter-plugin.ts`/`index.ts` import 指向 pi-adapter（审查 A2）；`runtime.ts`/`plugin.ts`/`tokens.ts`/`types.ts` 不动。

## 语义变更清单（等价迁移之外的显式落档）

- toolcall index：wire 稀疏原值 → pi 稠密（下游兼容，已核）。
- 中途 usage 帧消失：usage 只在终态事件（done/error）携带；流中不再有独立 usage 帧
  （StreamAccumulator 覆盖式捕获兼容；「字段级合并不归零」移交给 pi 内部，真身冒烟防守）。
- redacted_thinking：旧跳过 → pi 广播 `[Reasoning redacted]` thinking 块（透传为 thinking-delta）。
- SSE 停读/连接释放/ping/CRLF/字节撕裂防守：随 wire 删除整体移交 pi（放弃面）；
  真身冒烟覆盖 destroy/非2xx/refused 三态。
- Retry-After：头捕获路径保真（秒/HTTP-date/毫秒语义头四态真身用例）。
- 未知 stop_reason：旧 fail-open 落 stop → pi throw "Unhandled stop reason" → error 事件 → network
  （可重试）——注入层用例锁定口径。
- 尾段断流（已发 stop_reason、未见 message_stop）：旧宽容收尾（成功收轮）→ pi 严格 throw →
  network 整轮可重试。
- 提前 break/throw 止损：piChunks finally 对上游迭代器 return() 仅 fire-and-forget（pi EventStream
  挂在内部 await 时 await return() 会 pending）；流止损依赖 abort signal——消费方纪律。

## 问题域

- 处理：两协议工厂 wire 替换为 pi-ai api-level stream；双向映射；错误码/usage/abort 口径保持；
  thinking 透传保留。
- 不处理：pi 模型目录/builtinModels/presets/router（装配面维持手配 baseUrl/apiKey，另立项）；
  thinking 请求参数注入（维持 THINKING-STREAM.md 裁决）；OAuth/图像/bedrock/vertex/azure/google；
  适配器内重试（单 attempt——SDK `maxRetries:0` + retryProviderRequest 缺省 0，真身冒烟防升级漂移）。

## 并发/一致性预算

- 无新增并发面：单飞行迭代器；abort 双路径（请求前 throw / 流中 error→rethrow）。
- 内存：toolcall 无身份缓冲上界 = 单工具参数串。

## 拆分

- llm 包：`pi-adapter.ts`/`pi-context.ts`/`pi-events.ts` 新增；五 wire 文件 + 直测删除；
  **scene-server.ts 保留瘦身**——真身冒烟装置（审查 P5）。
- 测试三层：
  1. 注入层（工厂选项 `streamFn?` 注入事件剧本）：事件矩阵 toEqual（usage 断言恰形 `{input,output}` 两键）、
     context 矩阵、分类表（正例+词边界负例 13 行等价集）、abort rethrow 硬用例、终态恰一次（finish
     恰一帧且为末帧）、防御层用例（垃圾事件跳过/流耗尽→network）标注「防御层」不计 pi 语义覆盖；
  2. 真身冒烟层（options.fetch→scene-server，过 pi 真 HTTP/SSE）：非 2xx→`http-500`+体摘要、
     retry-after 头三态→retryAfterMs、SSE 中途 destroy→error 事件→`network`、connect refused→`network`、
     请求头断言（`accept-encoding: identity`、anthropic-version 单份、无 cache_control）、
     onPayload wire 形状（孤立 tool_use 合成 is_error——pi transform 防守）、
     usage 字段级合并（message_start input + delta 只回 output → done.usage.input 不归零）；
  3. 既有回归：stream-frames（thinking 流帧）、runtime、llm-retry 码表、e2e 假适配器旅程（不经过 pi）。
- docs 同批：LLM.md §1.4/§1.5 重写、LLM-RETRY.md（Retry-After 捕获路径不变，头来源改 onResponse）、
  THINKING-STREAM.md 引用更新。
- 探针文件（gap-probe/stream-sim/headers-probe）：工厂签名不变则续用；stream-sim 的观察对象
  变为「pi wire 到达节奏」，注释同批更新。

## 实施顺序

1. `pi-context.ts` + `pi-events.ts` 纯映射 + 注入层单测（零网络）；
2. `pi-adapter.ts` 两工厂 + 注入层事件矩阵 + 分类表；
3. scene-server 真身冒烟层；
4. 删五文件 + 旧测试迁移（按迁移表）+ docs；
5. 四门 + e2e 回归；real.ts 真凭证验证（1 次付费调用，用户拍板——含 GLM 逐 token 节奏观察）。

## 裁决

- 参考实现与版本：provider-pi + `@earendil-works/pi-ai@^0.85.1`（用户指令）。
- api-level stream 而非 Models.stream（审查 A1；参考实现自身的 Models 路径在无 env 下也是坏的）。
- 契约不变项如上（否决窗口）；删自研 wire 零双轨；重试留 llm-retry。
- `cacheRetention: "none"` 保持现 wire（缓存标记启用另裁决）；`fetch` 注入透传保留。
- 语义变更清单五项如上（否决窗口）。

## 测试口径

- 注入层：事件矩阵全量（含 P10 初值、tracker 三形态、deferred/未知 reason、redacted 文案、
  error.usage 先行）；context 矩阵（含 input 降级三态 `[1]`/`null`/`5`、toolName 回查、空 user、
  maxOutputTokens 注入、四角色）；分类表（词边界负例全表）；abort 三用例
  （请求前 throw / error{aborted} rethrow / 流中 signal 断）。
- 真身层：如拆分六项。
- 回归：stream-frames/runtime/llm-retry/e2e 全绿；runtime 工厂注册→network 用例标注「巧合绿」不计数。

## 验收清单

- [ ] 契约不变项逐条；语义变更五项落档并有对应断言
- [ ] 注入层矩阵 + 分类负例表 + abort 硬用例全绿
- [ ] 真身冒烟六项全绿（默认门内首次有 pi HTTP/SSE 真身防守）
- [ ] 五文件删净零双轨；docs 三份同批
- [ ] 四门全绿 + 覆盖率 ≥ 既有阈值（数字如实）
- [ ] 收口双对抗审查清零；real.ts 真凭证验证（用户拍板）
