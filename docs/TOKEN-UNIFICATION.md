# Token 计算统一：token-meter 事实层扩展 + token-analytics 消费 meter

> 状态：草案 v3（对抗审查①行为等价 + ②架构两项全部处置：阻断项 F1≡⑦b/F2 已修，D9/D10 新增裁决，F6-F15 落档；两审查独立命中同一高危缺口互相印证）
> 级别：中（跨包接口变化：meter 快照面扩字段；analytics 删本地折叠改消费服务）
> 上游：docs/TOKEN-METER.md（契约重写）、docs/PLUGINS.md 契约 1/5（消费方式变化）
> 动机：benchmark 实测暴露 print 模式 usage 事件缺缓存明细；两包各写一套 usage 折叠 +
> 各写一个 CJK 估算器（口径不同：1.25/字上界 vs 1/字典型值）——同一事实两个出处。

## 0. 需求与裁决（已定，引用会话裁决）

- 用户裁决 A：**usage 全链路带 cacheRead/cacheWrite**（不是只修 print 模式）。
- 用户裁决 B：**token-analytics 消费 token-meter**（不合并包、不下沉独立原语包）。
- 动机锚点：benchmark 是优化 agent 的手段——遇到 bug 修复即优化 agent 本身。

## 1. DESIGN

### 1.1 外部契约

**token-meter `SessionUsage` 快照面（事实层，扩字段）**

```ts
export interface RouteUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;    // 新增：inputTokens 子集明细（非加数）
  readonly cacheWriteTokens: number;   // 新增：同上
}
export interface TurnUsage {
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;    // 新增
  readonly cacheWriteTokens: number;   // 新增
  readonly routes: readonly RouteUsage[];
}
export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;    // 新增：累计缓存读
  readonly cacheWriteTokens: number;   // 新增：累计缓存写
  readonly totalTokens: number;        // 不变 = input + output（缓存是子集，防双计）
  readonly attempts: number;
  readonly lastReportedInput: number;  // 新增：尾值（input 在场才覆写；0 = 无实报哨兵）
  readonly lastReportedCacheRead: number; // 新增（审查①⑦b≡审查②F1）：尾值（cacheRead 在场才覆写）——命中率点态口径分子
  readonly lastUsageAt: number;        // 新增：最近实报事件 time（input 或 cacheRead 在场才更新）
  readonly turns: readonly TurnUsage[];
}
```

字段语义钉死：

- `input` 含 cache 总量（LLM 契约 pi-events.ts:21——`input = input + cacheRead + cacheWrite`）。
  cacheRead/cacheWrite 是它的**子集明细，非加数**；totalTokens 口径不变。
- **尾值三件套的覆写条件（审查①#2/⑦b 钉死，镜像旧 analytics 逐字段在场判定）**：
  样本通过 parseUsageSample 后——
  - `lastReportedInput` 仅当样本 `input` 字段**在场**时覆写（`{output:30}` 样本不得清零尾值）；
  - `lastReportedCacheRead` 仅当 `cacheRead` 字段**在场**时覆写；
  - `lastUsageAt` 当 `input` 或 `cacheRead` 任一在场时覆写（镜像旧 analytics 同条件）。
  垃圾样本（整丢）不更新任何尾值。
  上游配套（实现审查后补修）：pi-events 的 cacheRead/cacheWrite 恒透传（0 也是
  有效观测非缺席）——否则生产管线 cacheRead=0 时字段缺席，尾值滞留上一轮非零值，
  ⑦b 症状在真实链路复发。
  覆盖场景：autocompact 实报口径升级、analytics 的上下文占用面与命中率面
  （cacheHitRate = lastReportedCacheRead / lastReportedInput——分子分母各取在场
  尾值，与旧 analytics 尾值语义同源；累计÷尾值的错口径已审查①证伪）。
- **尾值缓存字段不进三路桶**（route/turn 不记尾值——尾值是会话级快照语义，
  不是累计语义，桶里放尾值是口径混淆）。

**meter 估算面统一出口（原 analytics 私有 estimateTokens 迁入）**

```ts
// token-meter/src/plugin.ts（或新文件 estimate.ts——见 §3 拆分）
export function estimateTokensTypical(text: string): number;  // CJK 1/字（显示口径）
export function estimateText(text: string): number;            // 既有：1.25/字上界（预算口径）
export const WIDE_TOKENS_PER_CHAR = 1.25;                      // 既有
```

**token-analytics 服务面（解读层）——签名零变化**

`TokenBreakdown` / `TokenAnalyticsOptions` / `TokenAnalyticsService` / 插件导出形状
（default 导出、inject 词表**增加** "token-meter"）不变。实现改消费 meter。

### 1.2 内部问题域（处理 / 不处理）

**meter 处理**：usage 样本解析校验（单一真相——analytics 不再自带）、累计折叠
（总量/route/turn 三路 + attempts）、尾值折叠（lastReportedInput/lastUsageAt）、
溢出 fail-closed、token 估算两种口径。

**meter 不处理**：上下文水位（remaining/utilization）、窗口解析（dial 折叠 +
llmRuntime 查表）、systemPrompt/tools 分项估算（依赖 system-prompt/tools 服务，
meter 是内核件不反向依赖）——全部留在 analytics。

**analytics 处理**：读 meter 快照 → 解读成 breakdown（水位/命中率/分项）；dial
折叠；分项估算（消费 meter 的 estimateTokensTypical）。

**analytics 不处理**：usage 解析校验、累计折叠——删本地 foldUsage/foldTarget。

### 1.3 并发与性能预算

- meter 增量折叠 O(1)/事件不变（尾值 = 覆写标量）。
- analytics breakdown() 从「全量重扫 WAL」变为「meter 快照读取 O(1) + 分项估算」
  ——每查询成本下降；无参形态（全会话聚合）从 O(全部会话×全事件) 变 O(会话数)。
- 插件不变式保持：analytics 模块级零可变状态（PLUGINS.md 契约 1）；meter 缓存
  保留上界 = 活会话数（sessionDisposed 摘除非泄漏）。
- **时序语义降级落档（审查①#8，文档改写时如实陈述）**：旧 analytics 每查询直折
  session.events()（append 后同步可见）；新链路 meter 缓存由 sessionAuditEvent
  驱动、审计投递是 queueMicrotask——append 与查询同 tick 时读数滞后一拍。
  生产 IPC 路径（轮完成→host 收到信号→发查询）跨 macrotask 实际排空；
  PLUGINS.md 契约 5「WAL 权威：每次查询直接折叠」的强保证改为「事件驱动增量
  + 冷启动全量折叠（增量==全量由构造保证）」——TOKEN-METER.md §1 既有表述。

## 2. 审计结论（旧实现 = 规格）

### 2.1 token-meter 现状

- fold.ts：增量==全量由构造保证；垃圾样本整丢；聚合溢出整账本作废（M23）。
  **缺口**：validUsage 只取 input/output（cache 字段丢弃）→ 本次修复主目标。
- plugin.ts：晚装载纪律（未知会话不建账）+ 游标去重 + sessionDisposed 摘除。
- 消费方：compaction×4 + autocompact×3（只用 estimateText——零影响）；
  apps/cli×3（usageOf：REPL 行、print 模式 usage 事件）。

### 2.2 token-analytics 现状

- foldUsage（本地）：只扫 assistant/message（**不含 assistant/attempt**）；
  字段级宽松解析（`usage.input !== undefined` 逐字段判，无垃圾整丢——负数
  cacheRead 会被累计！）；lastUsageAt 取 `input 或 cacheRead 在场` 的事件 time。
- foldTarget：无参形态扫全部会话取 lastUsageAt 最大者；有参形态取所询会话累计。
- dial 折叠（meta > request）+ 窗口查表（模型级 > 档案级 > 参数 > 200k）。
- estimateTokens（CJK 1/字典型值）与 meter estimateText（1.25/字上界）**两套
  码位判定逻辑**——CJK 码位表在 analytics，上界宽字符集在 meter（非 ASCII 全算
  1.25，含西里尔/emoji；analytics 只列 CJK 区段）。口径差是**有意**（预算 vs
  显示），但码位表应单一真相。
- 消费方：host-hub worker `get_token_analytics` 命令（唯一）。

### 2.3 行为差异清单（合并后必须裁决的口径冲突）

| # | 维度 | meter 现行为 | analytics 现行为 | 裁决 |
|---|---|---|---|---|
| D1 | 样本源 | message + attempt（失败尝试计费 M16） | 仅 message | **从 meter**：含 attempt。影响：attempt 带 usage 时 analytics 的尾值/累计会包含它——正确方向（计费口径一致），行为变化显式记录 |
| D2 | 垃圾样本 | 整丢（负 input/cacheRead 样本不进账） | 逐字段宽松（负 cacheRead 会被累计） | **从 meter**：整丢。修复 analytics 隐性 bug |
| D3 | lastUsageAt 触发 | 无此概念 | `input 或 cacheRead 在场` | **保持旧口径（审查①#2 修正）**：input 或 cacheRead 任一在场才更新——与旧 analytics 完全等价；`{output:N}` 样本不动任何尾值（见 §1.1 尾值覆写条件） |
| D4 | `{}` 样本 | 视为缺席不计 | `{}.input === undefined` → 不更新任何字段 → 等价缺席 | 一致（无冲突） |
| D5 | 尾值范围 | — | 会话内最后一条 | 一致（会话内最后有效样本） |
| D6 | 无参形态（全会话聚合） | — | 扫所有会话 lastUsageAt 最大者 | **保持 analytics 本地实现**（跨会话聚合是解读语义——meter 是单会话记账；meter 快照只有会话内尾值）。analytics 仍需遍历 store.list()，但每会话只调 meter.usageOf（O(1)），不再全事件扫 |
| D7 | output 聚合域 | 会话内累计 | totalOutputTokens = **world 全会话**累计（工作量面） | **保持 analytics 语义**：totalOutputTokens 仍 = Σ meter.usageOf(s).outputTokens（跨会话求和留在 analytics） |
| D8 | sessionOutput(sessionId) | — | 单会话 output 累计 | 改读 meter.usageOf(id).outputTokens（口径同构） |
| D9 | usageOf → undefined 的消费形态 | — | 未知会话 → 全零 breakdown（store.get 跳过） | **钉死（审查②F3）**：有参形态 usageOf undefined → 尾值/累计全零 + dial 照读 + total 退估算下限（镜像旧未知会话行为）；溢出会话在无参聚合中 skip（§3.2.3）且**有参形态同样走全零降级**（不得让 undefined/NaN 污染 12 字段协议面）。补用例：未知会话、溢出会话×无参聚合 |
| D10 | 尾值哨兵 0 与有效零样本 | — | `input !== undefined` 判定（`{output:N}` 不动 lastInput） | **镜像旧语义（审查①#2≡审查②F4，已入 §1.1 尾值覆写条件）**：lastReportedInput 仅 input 显式在场才覆写——0 只作哨兵，不存在有效样本清零尾值路径 |
| D11 | 仅 cacheRead 在场（无 input/output）样本 | 计（双缺席即缺席） | 累计 cacheRead + 更新尾值/lastUsageAt | **从 meter**（实现审查②#7 落档）：双缺席 = 缺席样本整丢——比旧窄但生产不可达（pi-events 恒发 input/output 两键）；上游恒透传后 cacheRead 在场时 input 必在场 |

### 2.4 审查落档（架构面 F2/F5/F6/F8/F9/F11-F15）

- **F2 typecheck 破坏清单（阻断项，已补）**：§3.1 文件表新增——apps/cli/src/__test__/
  format-usage.test.ts（字面量构造 SessionUsage/TurnUsage/RouteUsage 必填字段补全）；
  装配步骤补 `bun install`（token-analytics package.json 新增 @x-harness/token-meter
  依赖后需重建 node_modules 符号链接——实测现无）。
- **F5 D1 论证补齐**：pi error 路径先发 usage 再发 error finish（pi-events.ts:217），
  失败请求 input = 当时真实发送的上下文；abort 路径不发 usage 无污染。N4 补
  fatal 尾态断言。
- **F6 解析机制与前提（§3.2 新增小节）**：analytics 依赖 meter 的解析路径 =
  直接 import tokenMeter 对象 + apply 期 ctx.use 沿 scope 链上溯 root（与今取
  systemPrompt/toolRegistry 同路）；plugin-manager 路径 wrapper 丢弃 inject，
  硬依赖由 ctx.use 抛错 → installProcess 捕获 → failed 留痕降级（契约 4 既有语义）。
  两个前提钉死：① token 身份依赖同 realpath 模块解析（宿主 build 必须 --external
  @x-harness/*——现状即如此）；② 仅 process 模式成立（WORLD_TOKENS 不含
  tokenMeter，worker/caps 面取不到；本次 builtin 走 process 无碍）。
- **F8 性能预算改口**：usageOf 每调用 snapshotOf 全量物化 O(累计 turns)；
  §1.3 声明从「O(1)」改为「O(会话累计 turn 数)，快照物化每查询一次」。
- **F9 缓存驻留落档**：无参首调冷折全部会话并驻留至 dispose；峰值 = 活会话数；
  生产面只用有参形态，实际影响小。
- **F11 R1 改口**：validUsage 导出后 analytics 不再消费（只读快照）——「复用」
  删除；导出理由 = 单一真相供未来直接解析 usage 的消费方 + 测试面。
- **F12 R2**：同审查①7a（两审同一发现）——CJK 表搬家，非共用判定。
- **F13 文档同步清单补齐**：TOKEN-METER.md §5 旧裁决「砍 cache/reasoning 桶」
  与本方案冲突需改写；SESSION.md usage? 词条补 cache 字段事实。
- **F14 中间态警告**：当前树 fold.ts 已改而 meter.test.ts 未跟（实测 1 failed
  /20 passed）——单 commit 纪律下中间态不可提交，实施第一步先修测试。
- **F15 用例补**：core loadPlugins 批内缺 meter 的 assertValid 用例（硬依赖
  唯一强制点）；resume 两阶段 phase2 补 lastUsageAt 断言。

### 2.5 真 bug 清单（本次修复）

- B1：meter validUsage 丢 cacheRead/cacheWrite（print 模式 usage 事件无缓存明细）
  ——修复 = 本次主目标。
- B2：analytics 逐字段宽松解析（负 cacheRead 入账）——随 D2 裁决修复。

### 2.5 重复代码清单（提取）

- R1：usage 样本解析校验（两包各一套）→ 单一真相进 meter（validUsage 导出）。
- R2：CJK 码位表/判定（两包各一套）→ 码位表**存储**进 meter，但**两口径各自持判据**（审查①7a 钉死）：
  `estimateTokensTypical` 保持旧 analytics 判据——CJK 区段表 + **码位计长**（代理对按一码位，token-analytics.ts:163）；
  `estimateText` 保持非可打印 ASCII 判据（西里尔/希腊 1.25/字）。
  严禁「共用判定」实现成共用字符分类——西里尔文本两种分类结果不同（旧典型值 ceil(6/4)=2，若误用宽字符判据变 6）。

## 3. IMPLEMENTATION（施工图）

### 3.1 逐模块裁决表

| 模块 | 裁决 | 说明 |
|---|---|---|
| meter/fold.ts validUsage | 重构 | 扩 cacheRead/cacheWrite 校验 + 导出（analytics 复用） |
| meter/fold.ts FoldState/applyEvent | 重构 | 累计 + 尾值（lastReportedInput/lastUsageAt）双面折叠 |
| meter/fold.ts snapshotOf | 重构 | 快照输出新字段（三路桶 + 会话级尾值） |
| meter/plugin.ts estimateText | 保留 | 不动 |
| meter 新文件 estimate-typical.ts（或并入 plugin.ts） | 新增 | estimateTokensTypical + CJK 码位表迁入（R2 单一真相） |
| analytics foldUsage/foldTarget | 删除 | 改读 meter（D1-D8 裁决口径） |
| analytics breakdown 聚合段 | 重构 | meter 快照 + dial 折叠（保留）+ 分项估算（保留，换 estimateTokensTypical） |
| analytics dialOf*（meta/request 折叠） | 保留 | 解读语义，留 analytics |
| analytics inject 词表 | 修改 | + "token-meter"（硬依赖：读不到即装配错误，非 softInject） |
| analytics package.json | 修改 | + @x-harness/token-meter 依赖 |
| 两包 __test__ | 改写 | 见 §3.3 |
| apps/cli/src/__test__/format-usage.test.ts | 改写 | 字面量构造补必填 cache 字段（审查②F2 typecheck 面） |
| token-analytics package.json + bun install | 修改 | 新增 @x-harness/token-meter 依赖，重建符号链接（实测现无） |

### 3.2 关键实现点（同构性锚）

1. meter 尾值折叠（审查①#2/7b 修正版）：applyEvent 内 validUsage 通过后按**字段在场性**覆写尾值三件套：
   `hasInput → state.lastInput = usage.input`；
   `hasCacheRead → state.lastCacheRead = usage.cacheRead`；
   `hasInput || hasCacheRead → state.lastUsageAt = event.time`。
   validUsage 返回值携带 hasInput/hasCacheRead 标记（样本 input 缺席时不得清零尾值）。
   **不进溢出判定**（溢出是累计语义，尾值覆写无溢出可言）——但溢出后
   usageOf 返回 undefined（快照整脸不可用，尾值随之不可见——fail-closed 一致）。
2. analytics breakdown(sessionId)：
   `meter.usageOf(sessionId)` → totalCacheRead/totalCacheWrite/outputTokens/
   lastReportedInput/lastReportedCacheRead/lastUsageAt 全取自快照；
   **cacheHitRate = lastReportedCacheRead / lastReportedInput**（审查①7b：分子分母
   同尾样本，与旧 analytics :127/:130/:251 同源口径严格等价；禁止累计÷尾值）；
   dial 折叠保留本地（读 session events——dial 折叠是事件投影不是 usage 记账，
   不属于本次统一域）。
3. analytics breakdown()（无参）：遍历 store.list() 逐会话 meter.usageOf，
   取 lastUsageAt 最大者的尾值（**平局取列表序靠后者——>= 比较**，镜像旧 :204）；
   Σ outputTokens；**无参 totalCacheRead/Write 恒 0**（镜像旧 :209-213）；
   **溢出会话（usageOf undefined）排除出聚合**。
   **注意**：meter.usageOf 对未知会话冷启动全量折叠并常驻缓存（sessionDisposed
   摘除）——首次无参调用成本 = 一次全历史扫（与旧同阶），之后 O(1)；
   保留上界 = 活会话数（非泄漏，§1.3 落档）。
4. sessionOutput(id) = meter.usageOf(id)?.outputTokens ?? 0（语义同构：旧实现
   读该会话全部 assistant/message.output 求和 == meter 累计，含 attempt 的
   D1 口径差异按裁决执行）。

### 3.3 测试迁移矩阵

| 旧用例（analytics） | 处置 |
|---|---|
| total=实报优先/messages=差值/缓存四字段断言 | 改写：数值不变，装置加 meter 在场（makeTestWorld 已装 meterKit——test-world.ts:49 已满足！） |
| 无实报 total=估算下限 | 保留原样（不涉及 meter） |
| CJK 估算段 | 改写：断言 estimateTokensTypical 语义不变（400 CJK ≥400） |
| 双适配器窗口症状回归（200k 症状） | 保留原样（dial 域不涉及 meter） |
| 模型级窗口优先 | 保留原样 |
| 多会话独立计 | 改写：sessionOutput 改读 meter——断言值不变 |
| 无参兜底 200k | 保留原样 |
| default 导出装载形状 | 改写：inject 词表 +token-meter |
| resume 全历史两阶段 | 改写：断言不变（meter 冷启动保证 resume 数值在场——这正是 meter 晚装载/冷启动纪律的既有保证） |

| meter 旧用例 | 处置 |
|---|---|
| 记账矩阵/归因/溢出/空流 | 改写：快照断言补新字段（cacheReadTokens 等为零默认）|
| 增量==全量 | 保留 + 新增尾值断言 |
| 晚装载冷启动 | 保留 |

新增用例（真 bug 回归 + 契约）：

- N1【B1 症状】：message 带 cacheRead/cacheWrite → 快照三路（session/route/turn）
  累计正确；print 模式 usage 事件含 cacheReadTokens（apps/cli print-mode 已有
  `...usage` 摊开——补 e2e 断言或直接断快照形状）。
- N2【B2 症状】：负 cacheRead 样本 → meter 整丢（analytics 消费面顺带修复断言）。
- N3：尾值面——多轮后 lastReportedInput/lastReportedCacheRead/lastUsageAt = 最后
  有效样本（字段在场才覆写）；**审查①#2 症状回归：`{output:30}` 样本不清零
  lastReportedInput/不更新 lastUsageAt**；垃圾样本不更新任何尾值；溢出后
  usageOf undefined。**审查①7b 症状回归：两轮 input=500/1000、cacheRead=400/0
  → cacheHitRate = 0/1000 = 0（非累计口径 0.4）**。
- N4：D1 口径——attempt 带 usage 时 analytics 尾值包含它；**sessionOutput 同样
  包含 attempt.output（累计侧，审查①#1 补）**。
- N5：两口径估算同源——estimateTokensTypical("好"×400) = 400；
  estimateText 同文本 ≥ estimateTokensTypical（上界 ≥ 典型值恒成立）；
  **审查①7a：西里尔文本 estimateTokensTypical = ceil(len/4)（非 CJK 走 other 桶，
  严禁误用宽字符判据变 1/字）**。
- N6：D6/D7——无参 breakdown 跨会话聚合取 lastUsageAt 最大者；**平局取列表序
  靠后者**；totalOutputTokens = 各会话 outputTokens 之和；**无参
  totalCacheRead/Write = 0；溢出会话排除出聚合**（审查①#4）。

### 3.4 实施顺序（单波次——改动面小且强耦合，拆波反而制造中间态）

1. meter：fold.ts（validUsage 导出+扩字段+尾值）→ estimate-typical.ts → 测试改写+新增
2. analytics：删 fold → 改 inject/依赖 → breakdown/sessionOutput 重写 → 测试改写
3. 文档：TOKEN-METER.md §1 契约重写（新快照面 + 尾值语义 + 两种估算口径）；
   PLUGINS.md 契约 1/5（analytics 消费 meter、fold 删除、口径变化 D1/D3 记录）
4. 四门：typecheck/lint/build/test 全绿 + 覆盖率不降
5. 对抗审查（独立会话审 diff，对照本方案 §2.3 裁决表逐条核）
6. 真实验证：GLM 端点跑一次 print 模式，usage 事件含 cacheReadTokens（B1 症状消失）

### 3.5 回滚方案

单 commit 实施（meter+analytics+测试+文档同提交）；异常时 revert 单提交即回
到双折叠架构。无数据迁移、无持久化形状变化（快照是内存面）。

## 4. 验收清单

- [ ] 四门全绿（lint 0-0 / typecheck / build / test），覆盖率 ≥ 现值只升不降
- [ ] 对抗审查偏差清单清零（每条：修掉 或 引用裁决节号）——审查①9 项 + 审查②15 项均已处置进 v3，实施后还需一轮 diff 审查（技能 §7：实现后独立会话对照旧实现审 diff）
- [ ] B1 症状回归用例在场并通过（print usage 事件含缓存明细）
- [ ] B2 症状回归用例在场并通过（负 cacheRead 整丢）
- [ ] D1/D3/D9/D10 行为变化有显式用例 + 文档记录（不是静默漂移）
- [ ] 真实 GLM print 模式验证：usage 事件 cacheReadTokens > 0（GLM 隐式缓存命中）
- [ ] analytics 全部旧用例按迁移矩阵处置（无静默删除）
- [ ] TOKEN-METER.md §1/§5 / PLUGINS.md 契约 1/5 / SESSION.md usage? 词条同步（文档与代码同变，单提交）
- [ ] smoke-dist 用例保留且真跑（token 身份分裂暴露面——审查①#8）
- [ ] 中间态不可提交（F14）：实施第一步先修 meter.test.ts 使四门回绿再继续
