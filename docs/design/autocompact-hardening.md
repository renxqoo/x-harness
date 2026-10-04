# autocompact 加固：失败可见、熔断自愈、压缩不瘫

状态：已实施（对抗审查处置完毕，见 §7）
分级：中级（跨 compaction/autocompact/harness/host-hub 四包，新 journal 事件类型，无外部 API 契约变更）
起因：会话 20260930T022303-cmxidv 占用爬到 944k 仍未压缩。根因链：checkpoint 三连败 → breaker 永久置位 → L2 连坐死亡 → L1 按 no-gain 放弃 → 85% 水位 compact 每步快速失败且静默 → 无本地上限，provider 不报 413 就永不停止。

## 1. 问题域

处理：

1. 压缩链失败不可见（诊断只写 worker stderr，journal/telemetry 双无源）；
2. breaker 无自愈（broken 仅 session dispose 复位，worker 长寿 = 永久熔断）；
3. 无过错失败与 provider 失败共用三振计数；
4. L2 账本替换被 broken 连坐（它不调 LLM，不需要这个前置）；
5. 全量摘要一次性发整个待压 span（70 万 token 级请求结构性失败）；
6. summarizer 与主对话同 dial，thinking max 波及内部请求；
7. 压缩失败后任务无停止路径（用户裁决：三振停机，手动恢复）。

不处理：

- emergency 路径（http-413/context-overflow 触发）行为不变；
- L1 清洗策略、水位百分比、tier 表不变；
- 旧会话回放兼容：无新历史数据回填需求；
- worker stderr 持久化：诊断改走 journal 后不再依赖 stderr（UI 侧消费 journal 事件）；
- summarizer 分段摘要的质量评估（摘要好坏不在本次验收面）。

## 2. 外部契约

### 2.1 journal 事件（新增 3 类，session 事件面枚举加项）

| 事件类型 | 载荷 | 产生时机 |
| --- | --- | --- |
| `compaction/diagnostic` | `{ turn, step, origin, code, detail? }`，origin ∈ compaction \| autocompact | 每次压缩/checkpoint/摘要失败，原因码透传；三振循环内层失败降为 stderr+token 事件（journal 每 step ≤ 3 条，见 §4） |
| `compaction/exhausted` | `{ turn, step, attempts }` | 85% 水位 compact 三振，任务暂停前；session 重载时由 journal 尾部（exhausted 事件之后无 replace）重建标记 |

checkpoint 失败不另设事件类型——与压缩诊断共用 `compaction/diagnostic`，blame 放 detail。

词表封闭：code 枚举 = 现有 warn code 全集（summarize-failed、summary-truncated、summary-empty、summary-input-budget-exhausted、no-cut-point、trigger-noop、checkpoint-failed、file-ledger-empty、l1-no-gain、l1-redact-failed、gate-soft-fail、budget-gate-release、l2-no-progress、watermark-failed、served-window-write-failed）加 compact-exhausted。

### 2.2 preStep reject 语义（既有 agentPreStep 契约加项）

`{ kind: "reject", reason: "compact-exhausted" }`：turn 收 blocked，reason 词表加 compact-exhausted。面向用户的恢复提示由消费端（host/cli）按 reason 渲染，本插件只出结构化 reason。用户取消（step signal abort）与 summarizer abort 返回的 aborted 不计三振、不置 exhausted。

### 2.3 exhausted 标记生命周期

置位：compact 三振（记录置位时 epoch）。清除：一次成功的 compact（manual 或 auto）、session dispose（epoch 递增后旧标记作废）。存在期间每条用户消息 preStep 返回 reject；autocompact gate 同步暂停（gatePaused，事件驱动）。跨重载持久化：sessionCreated 时扫描 journal——尾部存在 `compaction/exhausted` 且其后无 replace 型 user/message 落地则重建标记。三振循环内层 warn（summarize-failed 等）降级为 stderr+token，journal 只记外层 trigger-noop（每 step ≤ 3 条）。

### 2.4 配置面

hub-settings 新键 `compaction.summarizer: { provider?, model }`（可选，缺省从 catalog 选同 provider 的 flash 级模型，无 flash 则回退主 dial 并落一条 diagnostic）。`CompactionOptions.summarizer` 既有字段不变。

## 3. 六项改动

### 3.1 诊断落 journal

compaction/plugin.ts 与 autocompact/plugin.ts 的 warn 函数：stderr 照写，同时 `session.append` 一条诊断事件。删 warnOnce 的静默语义（warnOnce 保留去重只作用于 stderr，journal 每次都落）。删 NOOP_SILENT_REASONS 清单。

### 3.2 checkpoint 失败分类计数

failOnce 拆两分类：
- blame=provider（runTextRequest 返回 failed）：计 consecutiveFailures，三次 broken；
- blame=self（aborted/empty/空段/unparsable）：不计，落 journal 事件，退避（下次 preStep 自然重试）。

breaker 自愈：autocompact/plugin.ts 的 onSessionEvent 在 `turn/start` 时 consecutiveFailures=0、broken=false。

### 3.3 L2 去 broken 连坐

escalator.ts `ledgerReadyForL2` 改为只判 `ledgerReady(state.ledger)`。broken 只禁开新 checkpoint job。

### 3.4 分段折叠摘要

compact.ts compactSession：不再把整个 span 一次发 summarize。按 `summaryInputMaxChars` 减滚动摘要预留（2 048 字符）切段（切点对齐 surface 节点边界），逐段滚动：每段调用前按当前滚动摘要重算 per-call 预算，段文本超预算截断；首段携带 span.previousSummary（PRESERVE 语义，与旧 compact 行为一致），后续段携带前段结果。任一段失败即整体失败（原因码透传该段失败码）。idle 超时 = base 120s + 每千字符 0.5s，上限 300s。

### 3.5 summarizer 独立 dial + thinking off

host-hub assembly.ts compactionPluginsOf：summarizer 模型解析顺序 = hub-settings 覆盖（provider 缺省取解析后的主 dial provider）> catalog 同 provider 含 flash 的模型 > 主 dial（回退写 stderr 诊断）。summarizer face 的 contextWindow 取 catalog 中该模型自己的窗口（缺失回退主窗口），预算不再错按主窗口计算。runTextRequest 流请求对 session `internal:summarizer` 钉死 thinking off（llm.stream 参数层）。

### 3.6 compact 三振停机

attempt 循环前置检查 signal.aborted 与 result.reason === "aborted"（用户取消不计失败）；确定性失败（no-cut-point/session-unknown/summarizer-unconfigured）立即停不退避；退避等待后 store 里会话已消失则放弃（防 dispose/重建竞态错杀）。

compaction/plugin.ts watermark 路径：`shouldCompact` 命中后同 step 内最多 3 次尝试（退避 2s/8s），全失败 → 落 `compaction/exhausted` → preStep 返回 reject。三振后不再自动降级 L2（用户裁决）。manual compact（/compact 命令）成功清除 exhausted 并允许任务继续。

## 4. 并发/一致性预算

- 三振重试串行（await 退避定时器），不并发开摘要请求；
- exhausted Map 与 inflight/epochs 同生命周期（dispose 清理）；
- 分段摘要每次仅一个在途 LLM 请求；分段切分基于 landSummary 前的 nodes 快照，落地时 epoch 校验防旧写覆盖（既有机制）；
- journal 诊断事件量级：失败场景每 step ≤ 3 条（三振上限），正常路径零新增事件。

## 5. 实施顺序

1. 3.1 诊断落账（先让失败可见，后续改动全部受益于它）；
2. 3.2 + 3.3（checkpoint 分类计数、自愈、L2 解耦）；
3. 3.5（dial 独立，3.4 依赖其请求更小更稳）；
4. 3.4（分段摘要）；
5. 3.6（三振停机，最后加停止语义）；
6. 四门 + 对抗审查 + 收口。

## 6. 用户裁决落档

- 「compact 请求失败了应该直接停止任务，让用户自己手动执行 compact」→ §3.6 三振停机、exhausted 标记、手动恢复（2026-10-05 会话）；
- 「重试 3 次，三次都失败直接终止」→ §3.6 计数为 3、退避 2s/8s（2026-10-05 会话）；
- 「修复 compact 请求为什么失败，一起解决」→ §3.4 分段折叠 + §3.5 dial 独立 + thinking off（2026-10-05 会话）；
- 85% 水位失败不再自动降级 L2 账本替换（三振即停，保持「让用户来」语义单一）——默认裁决，否决窗口随实现提交。

## 7. 对抗审查处置记录（2026-10-05）

修复：#1 取消/abort 不计三振；#2 summarizer 窗口按 flash 模型自身 catalog 窗口；#3 无 flash 回退写诊断；#4 exhausted 期间 autocompact gate 暂停（gatePaused 事件驱动）；#5 exhausted 跨重载由 journal 尾部重建（epoch 校验防错杀）；#6 三振循环内层 warn 降级 stderr+token（journal 每 step ≤ 3 条）；#7 summarizer-unconfigured journal 只落一次；#8 分段每调用重算预算并截断；#9 退避后验活防 dispose 竞态；#10 文档对齐（本节与 §2/§3 修订）；#11 裁决为保留 PRESERVE 语义（首段携带 previousSummary，文档 §3.4 已注明）；#12 append-fail 三振路径补 state.broken 置位与计数修正；#13 joinInflight 去 broken 连坐；#14 budget-exhausted 原因码独立；#15 sleep 定时器与 abort listener 全路径清理；#16 self-blame 仍 emit failed（telemetry 可见）不计数；#18 summarizer provider 缺省取解析后主 dial（装配下沉到 assembly 内）；#20 测试断言收紧（journal 恰 3 条、预算按公式推导）。

驳回：#17（resolveAt 无开放 turn 时标 turn 0——预存行为，影响仅诊断标签，不动）；#19（无序列化节点权重——serializeConversation 对空 part 节点返回空文本，段级预算由每调用截断兜底，实测无超窗）。
