# providers.json 输出上限 maxOutputTokens（两协议通用）方案

> 状态：已核销（两轮对抗审查各 2 并行子 agent，问题全部处置；四门全绿：161 文件 1882 用例，
> 覆盖率语句 92.35 / 分支 87.84 / 函数 92.84 / 行 94.55）
> 级别：中（providers.json 外部契约变形：字段改名 + 协议扩展 + 封闭模式校验；跨 apps/cli 与 packages/llm 两包）

## 契约

**providers.json（docs/CLI.md §2.2）**

- `ProviderProfile.maxOutputTokens?: number`——可选正整数，**两协议通用**；
  取代 `maxTokensDefault`（anthropic-only）——同名同义并存即双轨字段，旧名整体删除、不留别名读取。
- **封闭模式校验（根治静默吞没）**：顶层（`providers`/`default`）、档案（`name`/`protocol`/
  `baseUrl`/`apiKey`/`models`/`contextWindow`/`maxOutputTokens`）、default（`provider`/`model`/`thinking`）
  三层各自只认闭集键，未知键报 `<路径>: unknown field "<key>"`——改名后的旧名 `maxTokensDefault`
  落此门即显式报错（allowed 列表含新名，可行动），杜绝静默回落 8192/静默无上限。
- 校验：`maxOutputTokens` 非正整数 → `providers[i] (<name>).maxOutputTokens: expected a positive integer`；
  openai 档携带合法（原 anthropic-only 拒绝门删除）。

**@x-harness/llm 工厂选项（docs/LLM-PI.md）**

- `AnthropicCompatOptions.maxOutputTokens?`（原 `maxTokensDefault` 改名）、
  `OpenaiCompatOptions.maxOutputTokens?`（新增）。
- 注入语义（两协议同一实现）：
  - `effective = request.maxTokens ?? options.maxOutputTokens`（请求显式值恒胜档案配置）；
  - anthropic：`effective` 在场才注入 `options.maxTokens`（**全缺席不注入——本地 8192 兜底已废除**，wire 省略 `max_tokens`，服务端默认接管）；
  - openai：仅 `effective !== undefined` 才注入——配置在场即显式注入，配置与请求双缺席则不发（现状保持）；
  - pi Model 条目元数据 `maxTokens: effective`（缺席 undefined——与注入同源；本地兜底废除后两协议对称）。

**装配（apps/cli build-world.ts）**

- `adapterOptionsOf` 两协议统一透传 `maxOutputTokens`（分支收敛为单一返回——两分支字段集合同后判别只剩返回类型注记）。

## 问题域

- 处理：providers.json 字段解析/校验/改名 + 封闭模式校验；llm 工厂选项改名 + openai 扩展；maxTokens 注入条件重写；文档同步。
- 不处理（归属）：
  - CLI flag（如 `--max-output-tokens`）——归未来 CLI 面需求；本需求只做档案配置面；
  - dial 层显式上限（`AgentOptions.maxTokens` → request/header 落账）——已有通道（compaction summarizer 在用），档案级配置走 adapter 兜底层，不进会话事件流、不参与 foldDial 粘性。已知不变量：CLI 宿主不设 dial.maxTokens，故 header 粘性恒不遮蔽档案值；该不变量由 agent-loop `request.test.ts` 既有「header 回填」用例补 maxTokens 一格钉死（防未来 flag 落地时活化）；
  - compaction 的 `summarizer.maxOutputTokens`（摘要面输出上限）——同名不同物，类型面无共享 import，不动；
  - `request.maxTokens` 的 0/负值无正值门——**存量缺口，登记挂账**（位置：agent-loop step.ts 校验只查 isInteger；该包现有他人 in-flight 改动，不越界代修）；
  - ~~`DEFAULT_MAX_TOKENS = 8192`~~——已废除（实施后用户裁决）：全缺席不注入，服务端默认接管；本地硬编码兜底会顶掉真实配置（事故形态）。

## 并发/一致性预算

不涉及：纯装配期常量传递，无 IO、无定时器、无并发面。

## 拆分

- `packages/llm/src/pi-adapter.ts`：`AdapterCoreOptions` 字段改名 + `OpenaiCompatOptions` 增字段 + 注入条件重写；
- `apps/cli/src/providers-file.ts`：`ProviderProfile` 字段改名、`parseOptionalNumbers` 删 protocol 参数并重写陈旧注释（工作区半拆遗留）、三层封闭模式校验；
- `apps/cli/src/build-world.ts`：`adapterOptionsOf` 透传；
- `packages/agent-loop/src/__test__/request.test.ts`：既有「options 部分 → header 回填」用例 header 补 `maxTokens` 一格（不变量钉死；request.ts/该测试均不在他人 in-flight 改动集内）；
- docs（全库 `rg maxTokensDefault` 清零为准，历史审查记录段豁免）：CLI.md §2.2（示例/校验）与 §4（测试口径）；LLM-PI.md 契约·不变 item 2（工厂签名）、契约·变更 item 1（注入语义）、测试口径节；LLM.md §1.4 适配器职责（注入权威句）、工厂签名节。LLM.md §6 历史审查处置记录保留原文（记录属性，等同 CHANGELOG）。
- 依赖方向不变：apps/cli → packages/llm。

## 实施顺序

单批完成（改动内聚无中间可交付态）：文档先行 → llm → cli → agent-loop 测试一格 → 四门 → 对抗审查 → 提交。
无过渡态（旧字段一次删净，单轨收口）。

## 裁决

- **改名取代而非并存**（引用 AGENTS.md「同一事实只需要一套接口实现」默认裁决，否决窗口随提交开放）：
  `maxOutputTokens` 与 `maxTokensDefault` 是同一事实（档案级输出上限兜底）。既有 providers.json
  需手工改字段名——不写兼容读取，不写迁移脚本；改名信号由封闭模式校验显式给出。
- **封闭模式而非特判旧名**（审查 P1/F1 处置）：未知字段拒绝一次根治所有改名/拼错的静默失败，与仓库词表封闭风格一致；不做只盯 maxTokensDefault 的单名特判（那是下一次改名的最小修补）。
- **openai 配置在场即注入**（默认裁决）：档案配置是用户显式声明，注入即尊重显式配置；
  双缺席不发保持 openai 现状（语义不对称仅存于「anthropic 协议必填恒注入」一点）。
- **请求显式值恒胜档案配置**：与既有 `request.maxTokens ?? maxTokensDefault` 折叠序一致。

## 测试口径

- providers-file（表驱动）：
  - 正例：openai 档带 `maxOutputTokens` 解析通过并携带值（原错例翻转）；anthropic 档携带值 roundtrip；
  - 错例：`maxOutputTokens: 0` → expected a positive integer；
  - 封闭模式：档案未知字段（含旧名 `maxTokensDefault`）、顶层未知字段、default 未知字段 → unknown field 且错误带路径与 allowed 集。
- pi-adapter（streamFn 捕获 options 断言）：
  - anthropic：配置 4096 + 请求缺省 → options 与 **model 条目**均 4096；请求显式 64 → 64（恒胜）；双缺席 → 8192（既有用例改名扩展）；
  - openai：配置 2048 + 请求缺省 → options 与 model 条目均 2048（新增）；配置在场 + 请求显式 128 → 128（新增）；
    双缺席 → options 不含 maxTokens 键、**model 条目 8192**（钉住元数据/wire 不对称，新增断言）；配置缺席 + 请求显式 → 注入请求值（既有）。
- adapterOptionsOf（新增纯函数直测 `adapter-options.test.ts`）：两协议各一档，断言在场/缺席键形态（防 spread 键名拼错静默绿）。
- agent-loop request.test.ts：header 回填用例补 maxTokens 一格（options 缺 + header 在场 → 回填）。
- 回归：无（功能新增，非 bug 修复）；工作区既有红例（openai 档 maxTokensDefault 拒绝门半拆）随字段删除与封闭模式自然收口。

## 审查处置（定稿前 2 并行子 agent，问题清零）

- P1/F1 旧字段静默吞没（高，两审一致）→ 采纳根治：三层封闭模式校验（见契约/裁决）。
- F2 adapterOptionsOf 零覆盖（中高）→ 采纳：新增纯函数直测。
- P3/F3 Model 条目元数据零断言（低/中高）→ 采纳：矩阵补 model.maxTokens 断言；契约措辞更正（openai+配置非「现状保持」）。
- F4 dial 粘性不变量无守卫（中）→ 采纳最小：既有 header 回填用例补一格；不变量落「不处理」节。
- P2/F5 文档触点不全（中）→ 采纳：拆分行改为全库 rg 清零 + 历史记录段显式豁免；「契约 1/3」引用修正。
- P4 parseOptionalNumbers 陈旧注释（低）→ 随改名重写。
- F6 request 侧正值门缺口（低）→ 登记挂账（他人 in-flight 包，不越界）。

## 审查处置（代码收口 2 并行子 agent，问题清零；无假绿/无语义偏差结论）

- anthropic 双缺席格 + openai 显式格的 model 条目断言缺口（低，两审一致）→ 采纳：补两处 model.maxTokens 断言。
- pi-wire.test.ts 三处「仅显式才发」措辞被新语义超越（低）→ 采纳：改「双缺席不发」；LLM.md 真身冒烟清单同句同步。
- providers-file 正例可选字段缺席只查 contextWindow（nitpick）→ 采纳：补 maxOutputTokens 缺席断言。
- LLM-PI.md 续行缩进与列表项风格不一致（极低）→ 采纳：对齐 3 空格。
- resolve-model.ts 尾随空白行（卫生）→ 驳回处置：他人 in-flight 改动（早于本任务存在于工作区），本提交不含该文件，归属其作者。

## 验收清单（逐项核销）

- [x] providers.json：`maxOutputTokens` 两协议通用、正整数校验；三层封闭模式校验（旧名 maxTokensDefault 显式报错、错误带路径与 allowed 集）
- [x] llm：两工厂选项齐备；注入矩阵（anthropic 恒注入 / openai 显式才发）options 与 model 条目逐格有断言
- [x] 装配：`adapterOptionsOf` 两协议透传有直测
- [x] agent-loop：header 回填用例含 maxTokens 格
- [x] 文档全库 `rg maxTokensDefault` 清零（历史审查记录段豁免）且与实现零漂移
- [x] 四门全绿 + 覆盖率 ≥90/85 只升不降，数字如实报告（语句 92.35 / 分支 87.84 / 函数 92.84 / 行 94.55；lint 全库存量 3 处失败属他人/已提交遗留——fence-grep.test.ts 未用导入与根目录 spike.test.ts console，非本任务文件，如实标注不越界代修）
- [x] 对抗审查（方案 + 代码两轮，各 ≥2 并行子 agent）问题清零
