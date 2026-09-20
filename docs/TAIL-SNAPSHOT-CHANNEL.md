# 尾部快照通道（日期/类型表/项目指令出锚点）方案

> 状态：已实施（2026-09-21 定稿评审 + 实施收口双路对抗审查，处置见文末两节）
> 级别：中（跨 agent-loop / agent-delegation / skill / compaction / autocompact / apps-cli；
> 锚点内容契约收缩 + 新增注入通道；无 WAL 事件形状变更）
> 来源：会话裁决 2026-09-21。用户裁决：A+B 立项；C（system 漂移尾部追加化）**不做**；
> C'（AGENTS.md/CLAUDE.md 注入通道，当前全仓零引用）本批加入。

## 缺陷本质（治本判据）

- **易变事实铸进 system 锚点**：日期（base-prompt `{{date}}`）与 agent 类型表
  （`prompt.section("subagent-types", "{{agentTypes}}")`，kick 时 refreshTypes 刷新变量）
  都在锚点内——任何变化触发头部 `replace[seq,seq]`，**整段对话前缀缓存失效**
  （事故会话实测 6 万 token 重 prefill）。锚点该装慢变事实，易变事实该走边沿注入。
- **项目指令无注入通道**：`AGENTS.md`/`CLAUDE.md` 全仓零引用——仓库指令文件对模型
  完全不可见。
- **正确模子已存在但未抽象**：skill 插件（`packages/skill/src/plugin.ts`）已经用
  「running 边沿 → 文本不在场 → surface append 一条 user/message」的幂等注入跑在
  生产里——本件把它抽成共用原语，三条易变事实共用一套接口。

## 契约

### 注入原语与落位时序（评审处置 H1 改写——对齐 skill 既成事实）

- **共用注入原语**（agent-loop 导出 `snapshot.ts`）：
  `createTailSnapshot({ ctx, loop, spec: { id: string; render(): string; onWarn?(m) } })`
  ——kind 经 render 的信封文本携带（无独立 SnapshotKind 类型——信封即单一真相）、
  clock 归 CLI 装配层（`FactsSnapshotOptions.now`，实施收口处置对齐）——语义：
  `agentStatus running` 边沿
  **同步**回调：`render()` 异常 → `onWarn` 一条、不 append、kick 不炸（M9）；
  正常渲染后做**在场判定**：**仅扫 append 型 user/message 节点的单 text 块**（F4
  根治——replace 型摘要节点排除在扫描面外，整段回显不误判在场），「信封 + 全文
  精确匹配」在场即跳过；缺席才 `session.append("user/message", {turn:0, step:0,
  content:[text]}, {surfaceOp:"append"})`。**幂等即节流**（内容维精确匹配）。
- **落位时序（如实）**：首 kick 的 running 边沿先于锚点落账（`driver.ts` kick 首
  行 emitStatus）——**首份快照落在锚点之前（预锚），进入 compaction 保护头，永不
  折叠、不参与切口语义**（与 skill 生产行为同形，其测试锚定 surface[0] 为清单块）；
  内容变更后的重注入副本落在当前 surface 尾部（锚点后，可折叠、走自愈环）。
  `deriveMessages` 首轮 = `[快照（序按装配序）, system, 本轮 user…]`；后续轮 =
  `[…, 新快照, 本轮 user…]`。**「本轮请求即携带」成立**（append 先于请求构造）。
- **快照消息形态**：user/message 单 text 块；统一信封首行 `<snapshot kind="…">` +
  supersession 次行 + body。**谓词单源**（L10）：`isSnapshotNode(node)` 从 agent-loop
  导出（compaction 已依赖 agent-loop），四重合取判定——append op ∧ 单 text 块 ∧
  信封首行 ∧ supersession 次行（F5/M11 收紧伪造面；用户刻意伪造四条的残余后果仅
  「该消息不作切口候选」——保守方向无安全面，落档接受）。skill 维持现状渲染
  （预锚豁免，不入信封体系——评审 F9：其豁免仅在生产常量语义上成立，表述如实）。

### 三条快照

- **A 日期快照**（apps/cli）：base-prompt 模板删 `- Today's date: {{date}}` 行；
  `promptFactsOf`/`BasePromptFacts` 的 `date` 字段删净（消费面已全量清点：
  base-prompt.ts/cli-prompt-sections.ts/main.ts + 两测试文件）。注入体
  `Today's date: YYYY-MM-DD (IANA tz)`，**clock 注入**（`now` 参数，测试可假钟）；
  粒度按天；「进程内定格」取舍废除。
- **B 类型表快照**（agent-delegation）：撤 `subagent-types` 段与 `{{agentTypes}}`
  变量（全仓消费方仅 plugin.ts:92-93 + 三处 docs）；**types-loader 改同步 fs**
  （readdirSync/statSync/readFileSync——评审 H2 裁决：同步红线优先，kick 边沿同步
  探测+渲染，类型变更**当轮 kick 可见**，不留一 kick 滞后；agents 目录几十个小文件
  的同步扫描与 C' 的 readFileSync 同成本类）。无类型 → 空串零注入。
- **C' 项目指令快照**（apps/cli 新装配件，**装配位写死：紧随 skillKit**）：
  每 kick 同步读 `cwd/AGENTS.md` 与 `cwd/CLAUDE.md`，**内容哈希去重**（软链/同内容
  只注一份，M8）；合并单条（AGENTS.md 在前）；幂等同上。**上限 64KB**（评审 H3 从
  256KB 下调：≈16k token，仍远超合理指令体量；**单件口径**——合计上界 2×单件为
  接受的残余面），**以 readFileSync 读到的 buffer 长度为准**（不预 stat，杜绝
  TOCTOU——L15；该面黑盒不可测，靠评审批注维持）；超限 → 拒注 + onWarn；读取失败
  分流——ENOENT 缺席合法静默、其余 IO 错误告警跳过（不与缺席同路吞掉）。超限/告警
  逐 kick 重复（无节流）——噪音面小，接受。`--system-prompt` 整替会话同样收到
  快照注入（快照装配无条件；方向符合本件目标，行为变化如实落档）。
  **worktree 语义裁决（M7/F7）**：全部会话注入**主进程 cwd** 的指令文件——worktree
  子代理读到主仓指令，接受为已知偏差（per-session cwd 是 delegation 独立契约面，
  另件）；render 签名不设 session 参数。**fork 种子（F7）**：父会话快照按白名单进
  子代理种子 + 全局边沿注入 → 变更后短时双份，supersession 收敛，落档接受。

### compaction 交互（评审处置改写）

1. **谓词排除的范围如实化**：`isTurnStartNode` 排除 `isSnapshotNode`——只对**尾部
   重注入副本**生效（首份在保护头内本就不参与）；**autocompact 五个消费点**（评审
   F2/M4 列明）：escalator `alignDownToTurnStart`（L2 切口对齐）、gate
   `reanchorCoverage`（外部压缩后重锚覆盖边界）、scavenger `lastTurnStartIndex`
   （在飞轮边界/L1 清理范围）、checkpoint `boxSegment`（段起点对齐）、checkpoint
   `conservativeBoundarySeq`（保守覆盖边界=首真轮起点前一节点）。逐点结论：均为
   保守方向（快照要么原文幸存要么自愈重注），单点修改自动传播。
2. **自愈环与成本模型**：尾部重注入副本被折叠 → 缺席 → 下次 kick 重注入 verbatim；
   每压缩周期对一份旧尾部副本的摘要 side-call 成本接受（指令几 KB、日期/类型几十
   至几百 token）；**首份预锚副本永不被折叠、零摘要成本、内容变更后永驻头部为陈旧
   副本**（supersession 行收敛——与 skill 常量块同位不同命，如实落档）。
3. **轮内缺席窗口（M6）**：水位触发的折叠发生在步内（preStep），链式轮内不再发
   running 边沿——当轮后续请求可能短暂缺失尾部快照，下一 kick 自愈。不做步内
   补注入（复杂度不值；现状锚点内容的对应语义为「受保护头永不缺席」——这是迁移
   后的已声明语义退化窗口）。
4. `previousSummaryOf` 只认对象形 surfaceOp 的 user/message 首 text 块（措辞按代码
   修正，F8）；快照 append 型不混淆。
5. `snapshot` 标签**不入** serialize 的 NEUTRALIZE_OPEN_TAGS（裁决：摘要输入保持
   原文可识别；`</`→`<\/` 转义已有）。

### 锚点静态化与迁移

A+B 落地后锚点只剩进程内静态内容（评审核实：剩余段/变量全为进程静态，动态例仅
plugin-examples）——正常永不漂移；旧会话锚点（仍铸日期/类型表）升级后首个 turn
触发**最后一次** replace 后稳定。无回填。C（system 漂移尾部追加化）不做（用户
裁决；触发场景已消解到 `--system-prompt` 类显式变更，现状 replace 兜底）。

## 问题域

处理：原语抽取 + skill 等价重构、A/B/C' 三注入、锚点内容收缩、types-loader 同步化、
compaction 谓词 + autocompact 消费点、文档同变。

不处理（归属落档）：

| 事项 | 归属 |
| --- | --- |
| C：system 漂移尾部追加化 | 用户裁决不做 |
| emergency 切口落在快照边界（极小窗+巨型指令的砖化残余面） | 另件；本件以 64KB 上限收敛该面并落档残余 |
| per-session cwd 指令（worktree 子代理读 worktree 的 AGENTS.md） | delegation 独立契约面，另件 |
| 步内补注入（消除轮内缺席窗口） | 不做——下一 kick 自愈，窗口已声明 |
| 指令文件父目录/home 递归 | 另件 |
| 快照的特殊保留策略（最新快照豁免折叠） | 不做——自愈环已保证 verbatim 常驻 |
| 时间维节流 | 内容维幂等已覆盖 |
| 子代理会话特殊化 | 全局边沿自然覆盖（内容按主进程 cwd，见 M7 裁决） |

## 并发/一致性预算（评审修正）

- 注入回调整体同步（无 await；skill 红线延续）；同步 fs 面 = 指令两文件 + agents
  目录扫描 + AGENTS/CLAUDE 读取，**本地盘假设**（冷页/NFS 非微秒级——F11 如实）；
  kick 粒度非步粒度。
- 每 kick 扫描 **4 次**（skill 保留 1 + 新 3；`session.surface()` 每次整组拷贝——
  L12 如实记账）；长会话数千节点的线性扫可接受。
- 同扇出内 notifier/evictIdle/refreshTypes 与快照回调无数据依赖（评审核实）；
  多会话独立边沿独立判定（skill 既有用例背书）。
- 自愈环不失稳：重注入只在 kick 边沿、compaction 单飞行 join、emergency 每
  (turn,step) 恰一次（评审核实）；病态仅存于极小窗+巨型快照（H3 残余面，上限收敛）。

## 拆分

| 位置 | 改动 |
| --- | --- |
| packages/agent-loop/src/snapshot.ts | `createTailSnapshot` 原语 + `isSnapshotNode` 单源谓词 |
| packages/skill/src/plugin.ts | 改用共用原语（等价重构——三处测试断言随统一词面/助手改写：blockPresent→textBlocksOf、告警词 inject failed→append failed、present.test 并入原语用例；在场判定随原语收窄 append-op 单块） |
| packages/agent-delegation/src/plugin.ts | 撤 subagent-types 段与变量；快照注入 |
| packages/agent-delegation/src/types-loader.ts | 异步 fs → 同步 fs（单一装载真相，spawn 与快照共用） |
| packages/compaction/src/cut.ts | `isTurnStartNode` 接 `isSnapshotNode`（autocompact 五消费点自动传播） |
| packages/autocompact/src/__test__ | 补快照形态夹具四面（L2 对齐/boxSegment 起点/conservativeBoundarySeq/lastTurnStartIndex） |
| apps/cli/src/base-prompt.ts | 删 `{{date}}` 行 |
| apps/cli/src/cli-prompt-sections.ts | `promptFactsOf`/`BasePromptFacts` 删 date |
| apps/cli/src/（新）日期与指令快照装配 | A + C'（装配位紧随 skillKit） |
| docs | 本方案 + SKILL.md §1.3 + AGENT-DELEGATION + **ELEVATION-DESIGN.md:98 + SDK-DESIGN.md:66**（F6 补） |

依赖方向不变（compaction/autocompact → agent-loop 既有；skill/delegation → agent-loop 既有）。

## 实施顺序

单批次：原语+谓词 → skill 等价重构（回归绿锚）→ types-loader 同步化 → delegation
切换 → compaction/autocompact 谓词与夹具 → CLI A/C' → 文档 → 四门。

## 裁决

- **用户裁决（2026-09-21）**：A+B 立项；C 不做；C' 本批加入；方案先审后动。
- **本方案裁决（评审处置并入）**：首 kick 预锚落位接受（对齐 skill 既成事实，非
  缺陷）；types-loader 同步化（不留滞后）；C' 上限 64KB、buffer 长度判定、哈希
  去重；在场判定收窄 append-op；信封四重谓词 + 单源导出，不引入事件 data 判别字段
  （保「无 WAL 形状变更」量级）；worktree 读主仓指令接受；快照不入中和名单。
- **待用户终审的残余接受面**：① 首份快照永驻头部（变更后为陈旧副本，supersession
  收敛）；② 轮内缺席窗口（下一 kick 自愈）；③ 极小窗+近上限指令的砖化残余
  （64KB 收敛后仍存理论面，emergency 快照边界切口另件）。

## 测试口径

- **原语表驱动**：在场跳过/缺席注入/内容变化重注入（旧条仍在场）/render 抛异常
  （onWarn 一条、无 append、kick 不炸）/append 失败走 onWarn。
- **同步点断言（M5 形态）**：同步触发（followup / ctx.emit(agentStatus)）返回后
  **立即**断言 surface 已含快照、零 await——照 skill plugin.test.ts 既有形态。
- **落位断言（H1 改形）**：首轮 `[快照集合成员 ⊂ system 之前]` + 本轮 user 在
  system 后；重注入副本位于尾部近 user 批次；**不钉三快照互序**（装配序产物）。
- **锚点静态锚（症状回归）**：日期翻天/类型增删后**不触发** system/message replace
  （用例名注明「易变事实变化致全前缀失效」症状）；迁移锚：旧锚点会话首轮恰一次
  replace 后稳定。
- **A**：Environment 段形状锚（无 {{date}}）；按天幂等；假钟翻天注入新条。
- **B**：无类型零注入；增类型 → **同 kick 当轮**注入新快照（同步装载锚）；
  `{{agentTypes}}` 变量面删净。
- **C'**：合并序（AGENTS.md 前）；双文件同内容 → 单份（哈希去重）；单文件变更
  重注入；缺席零注入；超 64KB 拒注+告警；读取失败跳过。
- **compaction**：cut 表驱动三面（切口候选/原话配额/护栏分母均不含快照）；
  autocompact 四面夹具（见拆分表）；折叠后自愈锚（折区间含尾部快照 → 下次 kick
  verbatim 重注）；伪造信封负面用例（四重缺一 → 仍是真轮起点）；在场判定抗摘要
  整段回显（replace 节点不扫描）。
- **skill 等价重构回归**：既有用例不动即绿。

## 验收清单

- [ ] 原语表驱动 + 同步点断言全绿；skill 等价重构零行为变化
- [ ] A：锚点无日期、按天快照、假钟锚、跨天不触发 replace
- [ ] B：段与变量删净、同步装载当轮可见、类型变化走快照
- [ ] C'：通道落地（合并/去重/幂等/64KB 护栏/装配位）
- [ ] compaction：谓词三面 + autocompact 四面 + 自愈锚 + 伪造负面用例
- [ ] 迁移锚：旧锚点首轮恰一次 replace 后稳定
- [ ] 残余接受面三项（首份永驻头部/轮内窗口/砖化残余）在方案与提交说明中可见
- [ ] 四门全绿 + 覆盖率只升不降 + 数字如实报告

## 评审处置（2026-09-21 双路对抗评审）

- **H1/F1 首 kick 预锚落位（两路同源，最重）**：核实属实（driver kick 首行
  emitStatus 先于 anchorSystem；skill 测试锚定 surface[0] 为清单块）。处置：接受
  预锚落位为契约（对齐 skill 既成事实），落位断言/保护头叙事/自愈环/成本模型五处
  改写；「尾部快照」更名「边沿注入快照」（首份预锚、重注入尾部）。
- **H2/F3 types-loader 异步 vs 同步红线（两路同源）**：核实属实。处置：装载改
  同步 fs，单一真相，spawn 与快照共用；测试锚「当轮可见」。
- **H3 指令上限与窗口砖化**：处置：上限 256KB→64KB + buffer 长度判定；残余面
  落档（emergency 快照边界切口另件）。
- **F2/M4 autocompact 五消费点**：处置：方案列明五点 + 保守方向结论 + 四面夹具。
- **F4 在场判定扫 replace 节点**：处置：收窄 append-op（根治）。
- **F5/M11+L10 信封伪造与双包字面量漂移**：处置：四重谓词 + `isSnapshotNode`
  单源导出；不引入事件 data 字段（量级裁决）；残余伪造面落档（保守方向）。
- **M5 同步断言不必然红**：处置：同步点断言形态写死。
- **M6 轮内缺席窗口**：处置：声明不做步内补注入，窗口落档。
- **M7/F7 worktree cwd + fork 种子**：处置：主进程 cwd 裁决 + 种子双份收敛落档。
- **M8 同内容双注 / M9 render 异常 / F6 文档两处 / L12 预算记账 / L13 假钟 /
  L15 TOCTOU / F8-F10 措辞**：全部采纳，见上文对应条目。
- **核实无问题面（两路一致）**：`{{agentTypes}}`/`date` 删净影响面完整；childReport
  /repair/checkpoint/anchorIndexOf/gates/迁移叙事成立；append 与 inbox 零交互；
  同扇出无数据依赖；自愈环不失稳；多会话扇出独立。

## 实施收口审查处置（2026-09-21 双路对抗审查）

- **H 落位/请求体端到端锚缺失（假绿面）**：处置：补原语级「预锚落位 + 本轮请求即
  携带」用例（surface 序 `[快照…, system, user, assistant]` + 请求体含信封全文）与
  CLI 注入级旅程（真装配世界：合并序/落位/改文件重注入/假钟跨天新条/零 replace/
  旧锚点迁移恰一次 replace）。
- **M 空串零注入断言弱（存活变异）**：处置：空串/异常路径改 `textsOf` 精确相等
  断言（钉死空 text 块垃圾注入变异）。
- **M 指令读取失败被 ENOENT 同路吞掉**：处置：catch 分流 ENOENT 静默/其余告警
  + EACCES 用例。
- **M `as never` 三连旁路 append 类型门**：处置：原语与测试全部去 cast 直书
  （与被替换的 skill 旧代码同形，typecheck 背书）。
- **M 原语签名与方案漂移 / skill「不动即绿」承诺不实**：处置：方案回写（签名
  实现形 + kind/now 归属 + skill 行如实改写三处断言变化）。
- **M AGENT-DELEGATION §7.1 旧子句残留 + §13 行未核销**：处置：删旧句、§13 行
  标记本件内核销。
- **M presence 多块条件无负面夹具**：处置：补「多块含快照全文不算在场」用例。
- **M 锚点静态症状/迁移锚未落位**：处置：类型侧（增类型跨 kick 零 replace）+
  CLI 侧（指令变更/假钟跨天零 replace + 旧锚点恰一次 replace 后稳定）双锚。
- **L 五件**：第五消费点 reanchorCoverage 为 gate 私有函数，与已测
  conservativeBoundarySeq 同构（首候选定位一致）+ 谓词单源传播——不另设直测夹具，
  由 gate 既有集成用例背书；plugin-examples 动态注册时机提前（预锚快照先于首话，
  仍在首请求 dial 前，可见性等价）落档；64KB 单件/合计口径、超限告警逐 kick 重复、
  TOCTOU 黑盒不可测、时区注释 +30min 修正——均已落档或入注释。
- **核实无问题面（两路一致）**：架构面（时序/谓词单源/自愈环/fork 种子/依赖方向/
  删净面/delegation 装配与 dispose）实现与方案一致；变异测试六项五死一存活
  （存活即 TOCTOU 不可测项，已言明）；「既有用例翻新」三处经审查确认强度不降
  （通知计数 2→3 为精确计量、锚点谓词定位不放过锚点丢失、告警词面双词过滤等价）。
