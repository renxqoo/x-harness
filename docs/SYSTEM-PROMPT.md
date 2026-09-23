# SYSTEM-PROMPT 件方案（锚点定位 sections + 变量插值 + 指纹）——回炉重写

> 状态：已实施（回炉重写；代码审查处置：δ/2ⁿ 注册序预热修复前向引用错序 + 回归用例）
> 级别：小级偏上（纯加法、单职责；定位代数是纯函数可穷举测试）
> 上游：docs/AGENT-LOOP.md §3；工具表不在此收集（loop 直取 toolRegistry）。
> 参考思想出处：my-agent packages/core/src/prompt（旧仓路径，未随迁）（锚点/指纹/缓存）；DSH/pi 的静态拼装验证口径。

## 0. 回炉动机（真缺口，对照参考语义子集 A1–A10）

- 插件互相不知道对方的 order 魔数——「排在核心段之后」只能靠约定数字，错位无诊断；
- assemble 无内容指纹——KV cache 前缀命中无法观测（生产 prompt 件的必要面）；
- 变量函数抛错行为未定义（A9：坏段降级不崩）；身份守卫注销两分支无测试；
- 每步重排重算（my-agent A10 的缓存思想）。

## 1. 契约

token：`systemPrompt` 服务（name "system-prompt"）。插件 `systemPromptPlugin`（无 inject）。

```ts
section(spec: {
  name: string;                 // 同名覆盖（后者胜）；注销按身份守卫
  after?: string;               // 锚点：置于 name=after 的段之后（缺席锚 → 约束 no-op）
  before?: string;              // 对偶：置于目标之前；after+before 同声明 → throw
  text: string;                 // 静态文本（动态值走变量函数）
}): Disposer;
variable(name: string, value: string | (() => string)): Disposer;   // {{name}} 单层插值；惰性
assemble(options?: { sessionId?: string }): { text; fingerprint }; // 合并投影（W2C）：根层∪会话层；缺省=纯根层向后兼容
scoped(sessionId).section(spec): Disposer;  // 会话层（锚定子集：只锚根层段名；同名顶替根段位）
```

定位代数（常量：δ=0.5、TAIL_BASE=1_000_000；before/after **共用**同一 per-anchor 后代计数器；
比较器平级 tie-break = 注册序——代数可产生并列位次（如 P before Q 且 Q after X，P 与 X 平位），
tie-break 保证全序确定）：

环检测在**注册期**（新增边时沿锚链查环——缺席锚不建边不影响检测；成环 throw 点名环成员，
与垃圾参数 throw 同位）；assemble 不再因环中弹。
- `after X` → 位次 = orderOf(X) + δ/2ⁿ（n = X 已有的 after 后代数——后注册者更贴近目标，「插在中间」语义）；
  `before X` 对偶取 orderOf(X) − δ/2ⁿ；链式锚递归合成；
- 约束成环 → throw（装配期诊断点名环成员）；after+before 同声明 → throw；
- 无边段位次 = TAIL_BASE + 注册序（无边段可插入锚链派生值之间——装配序即语义）；
- 同名覆盖后，旧段不再作为锚目标（新段顶替位置语义，**沿用旧注册序**——覆盖是改文本不是挪位）。

插值：`{{name}}` 整段替换；未注册变量保持原样；**变量函数抛错 → 该变量保持 `{{name}}`
原样**（降级不崩，垃圾输入原则）；单层不递归。

### 1.4 基础段（base/core 槽位）与 guidance 数据位（工具条件注入）

- **内核只持词汇表不持内容（后核销修正 1）**：`wellKnown.baseCore` 槽位名在本包；
  基础段正文（身份/守则/环境块 + facts 变量 + 入口归一）归**上层共享层** packages/harness
  （`packages/harness/src/base-prompt.ts` 的 `createBasePromptPlugin`——apps/cli 与
  apps/host-hub 两宿主同源消费；dsh 同构：内核 SECTION_ORDERS 槽位 + persona 在
  preset/bundle）。
- `createBasePromptPlugin(facts)`（@x-harness/harness）：单一 section `base/core`（身份/守则/环境块）+ facts
  变量（cwd/isGit/platform/shell）；`inject: ["system-prompt"]` 硬依赖 topo 保序。
  **facts 由宿主探测传入**（`probeBaseFacts` 同包——base-prompt-probe.ts 持 fs IO 边，
  正文面不做 IO）；入口 `normalizeBaseFacts` 归一：换行压空格
  （环境值不得伪造新段落——注入面收口）、垃圾降级 `"unknown"`。日期已迁边沿注入
  快照通道（docs/TAIL-SNAPSHOT-CHANNEL.md——时钟归宿主）。
- `wellKnown.baseCore = "base/core"`：**唯一跨包锚点词汇表**（内核所有）——工具守则段
  与追加段的缺省锚；基础段缺席时锚点 no-op 落尾（优雅降级）。`baseCore` 为其别名
  （保留一个版本周期）。
- **工具守则走投稿式（D3，ELEVATION-DESIGN §1）**：`ToolDefinition.guidance?: string`
  （tools 包纯数据位，env 解析后定型——配置感知；不进 LLM 序列化：schemas() 显式子集映射）；
  tool-core 在 apply 期直接停靠 section `tool/<name>`（锚 `wellKnown.baseCore`，词汇表
  内核所有）。**装配序硬约束（D6）**：带 guidance 的 tool-* 必须排在 system-prompt 之后
  （tryUse 即时求值，晚序=段静默缺失；sandbox/execEnv 同款先例）；无 prompt 服务的世界
  优雅降级不注册。`SectionSpec.text` 支持 `(() => string)` 函数形：assemble 期现算，
  抛错 → `[section <name> render error: <msg>]` 占位（段级降级——不中断装配意义上对齐变量级；变量是保持原样、段落是错误占位，方向异同 W1 审查 I-1 记录）。
- 拆段（基础段再细分）与 assemble 工具集过滤**明确不做**（过度设计裁决）：重启条件
  分别为「出现需要段间精确落位的第二消费者」「delegation 收窄子代理被全量 prompt
  实测干扰」。

## 2. 问题域

**处理**：section 注册/覆盖/注销、锚点定位代数（注册期环检测）、变量插值、指纹、
**排序缓存**（缓存面=排序结果，段集版本号失效；插值与指纹每次 assemble 现算——变量是
惰性闭包，"文本未变"不可判定，不缓存装配结果）。
**不处理**：按 agent 分层（ctx 层级即分层）；上下文注入（agent/pre-step 消费方）；工具表收集；
prompt 长度治理/压缩。

## 3. 测试口径（对照 A1–A10 逐条）

- 定位：after/before 基本序；缺席锚 no-op；链式锚递归；同锚多后代 δ/2ⁿ 贴近；无边段插链间；
  after+before 同声明 throw；注册期成环 throw（点名环成员）；**平位 tie-break 回归**
  （P before Q、Q after X → P 与 X 平位，注册序定先后）；
- 覆盖与注销：同名后者胜；旧 disposer 不误删新段（身份守卫两分支）；覆盖后锚目标顶替；
- 插值：字符串/惰性函数/未注册保持/单层不递归/函数抛错保持原样；
- 指纹：同内容稳定、内容变即变、变量值变（函数现算）→ 指纹变；
- 缓存：段集未变连续 assemble 文本+指纹相等（段集版本号断言零重排）；注册/注销后缓存失效；
- 契约：token 名锁定；assemble 确定性；注册垃圾参数 throw 表（空 name/after===name/before===name/text 非 string/value 非 string|fn）。

## 4. 验收清单

- [ ] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告
