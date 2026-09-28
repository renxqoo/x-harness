# CLI 权限模式 flag（--permission）方案

> 状态：定稿（2026-09-20 双路对抗审查——契约/语义对照面 + 测试盲区/假绿面——
> 问题合并处置后修订，记录见文末「审查处置」节）
> 级别：中（跨 apps/cli + packages/harness + packages/permission 三层透传；外部契约
> 新增 flag；无并发/一致性/不可逆面）

## 契约

- CLI flag：`--permission <plan|auto|full>`（arity 1，无短项别名）。缺省不传 =
  `auto`（行为不变）。垃圾值 → exit 2：`--permission: expected plan | auto | full
  (got "x")`——文案由 `MODE_KNOBS.join(" | ")` 生成（与词表联动，防快照脱钩）。
- 词表单一真相：permission 包导出运行时词表
  `export const MODE_KNOBS = ["plan", "auto", "full"] as const satisfies readonly ModeKnob[]`
  （保留元组类型；`DEFAULT_DENY_READ` 同款常量导出风格）+ 反向穷尽编译期检查
  （`[Exclude<ModeKnob, (typeof MODE_KNOBS)[number]>] extends [never]` 形态，
  防「类型侧扩展、常量侧漏跟」的双向脱钩）。CLI 枚举校验引用该常量，诚实
  cast（`(MODE_KNOBS as readonly string[]).includes(value)`）。
- fenceKit 签名：`fenceKit(o: { root: string; mode?: ModeKnob })` —— 条件展开
  省字段形态透传 `createPermissionPlugin`（仓库惯例，同 build-world.ts
  adapterOptionsOf）；不传时维持 plugin 内缺省 `?? "auto"`（缺省唯一真相保持在
  最底层被依赖的 permission 包——现状 fenceKit 硬编码 `"auto"` 的第二缺省随之删除）。
- buildWorld：`WorldOptions` 加 `permission?: ModeKnob` → fenceKit；openWorld 从
  `args.permission` 折入（main.ts buildWorld 调用处）。
- 互斥面：**无新增互斥对**（已考量：`--no-tools` + `--permission` 是「无效力」
  非矛盾，与既有 CONFLICTS 只收真矛盾对的哲学一致）。
- 生效面：REPL 与 `-p` print 共用 openWorld 装配路径；create/resume 都按**当次**
  flag 生效——mode 是进程装配事实，不落会话存档。REPL 内 reopen（/model、/new、
  /resume 切换会话）复用既有世界与插件集，mode 经 plugin apply 闭包保持。
- usage 与文档同变：usageText 新增独立 `permission:` 组（置于 tools 与 prompt 组
  之间）行 `--permission <plan|auto|full>  tool permission mode (default auto)`；
  docs/CLI.md §2.1 flag 表加行、§2.5 装配清单行改「按 flag 注入（缺省 auto）」、
  §2.6 resume 语义段补 mode 按当次 flag（含 plan 会话 resume 不带 flag 即回 auto
  的显式静默放宽后果说明）。

## 问题域

处理：

- 解析与枚举校验 `--permission`；
- 透传链 `CliArgs.permission → openWorld → buildWorld → fenceKit → createPermissionPlugin`；
- usage / docs 同步（§2.1/§2.5/§2.6）。

不处理（归属落档）：

| 事项 | 归属 |
| --- | --- |
| REPL 运行时切换（/permission 命令） | mode 在 permission plugin apply 闭包固定；reopen 类通道只重建会话不重建插件集，换不了 mode。运行时切换需 mode 面向 token 化或世界级重建，独立件立项 |
| 会话存档记录 mode | mode 是宿主装配事实非会话事实；resume 重建按当次 flag（§2.6 落行：plan 会话不带 flag resume 即回 auto——用户可感知的静默放宽，文档显式写明） |
| providers.json / 环境变量配置入口 | 本需求只做启动 flag |
| sandbox 插件档位与网络面 | full 档 bash 提权硬拒底线在 permission 裁决层既有实现；sandbox 代理层网络域名 ask（CONNECT 未预授权域）**不受 mode 门控**——print 非 TTY 形态下恒 deny，即 `--permission full -p` 并非零 ask（网络面） |
| **full 档路径工具界外的许可/执法两层语义** | ~~存量缺陷登记挂账~~ **已根治（docs/PERMISSION-FULL-UNRESTRICTED.md）：full 总括授权翻译为授权根 `"/"` 三面铺开（工具/围栏/网络），执法层零改动**。原挂账时对 bash 面的「不受影响、界外可写」断言一并修正——bash 围栏面同款断裂曾并存（full 裁决放行但围栏 writable 白名单拒），总括铺开后两面对齐 |
| print 模式 broker 行为 | 不变：非 TTY ask 显式 deny（permission 工具裁决层的 full 放行不受影响；网络面见上「sandbox 插件档位与网络面」行） |

## 并发/一致性预算

不涉及——纯装配期静态注入，无运行时状态、无定时器、无 IO。

## 拆分

| 位置 | 改动 |
| --- | --- |
| packages/permission/src/types.ts | `MODE_KNOBS` 常量（as const + satisfies + 反向穷尽检查） |
| packages/permission/src/index.ts | 导出 `MODE_KNOBS` |
| packages/harness/src/index.ts | fenceKit 签名 + mode 条件展开透传（删硬编码 "auto"） |
| apps/cli/src/parse-cli-args.ts | FLAG_SPECS 加项 + `CliArgs.permission` + checkEnums 引用 MODE_KNOBS + usageText permission 组 |
| apps/cli/src/build-world.ts | `WorldOptions.permission` 条件展开透传 fenceKit |
| apps/cli/src/main.ts | openWorld 内 buildWorld 调用折入 `args.permission` |
| packages/e2e/src/cli-journey.ts | 假 anthropic server 加 tool_use 剧本能力 + `--permission` 两条旅程腿（见测试口径） |
| docs/CLI.md | §2.1 flag 表加行；§2.5 装配行改按 flag 注入；§2.6 resume 语义补行 |
| 测试 | 见「测试口径」分节 |

依赖方向不变（apps/cli → harness → permission；e2e 已依赖 CLI 进程）。

**fenceKit 测试落点裁决**：harness 包 kits.test **不**加 fenceKit 用例——fenceKit
内嵌 createSandboxPlugin 装配期 assertProbes fail-closed（linux 需 bwrap+socat），
harness 包现有单测零平台依赖的纪律保持；mode 透传断言由 apps/cli 层 buildWorld
级旅程（fenceKit 经 buildWorld 全量装配，该平台面已被既有 run-print-mode.test
占据，不新增）+ e2e 真进程腿覆盖。

## 实施顺序

单批次直通链（无过渡态、无双轨）：词表 → fenceKit → CLI 解析/透传 → e2e 装置
与旅程 → 文档 → 单测补齐 → 四门。

## 裁决

- **flag 形态 = `--permission <plan|auto|full>` 单 flag 枚举值**（默认裁决，
  否决窗口）：与既有 `--mode <text|json>`、`--thinking <level>` 惯例同构；
  `--mode` 名已被输出格式占用；独立布尔 flag（`--auto`/`--full`/`--plan`）
  需三条互斥校验且宽泛词永久占用 flag 名空间。需求原话列举的「--auto --full」
  按模式名列举理解，非严格 flag 拼写。
- 缺省 `auto` 不变；缺省值唯一真相收归 permission plugin 既有 `?? "auto"`
  （fenceKit 硬编码第二缺省删除）。
- full 档界外路径工具语义本件时点按「存量缺陷挂账 + 行为快照锚定」处置——后续由
  docs/PERMISSION-FULL-UNRESTRICTED.md 根治（总括授权三面铺开），快照用例已随根治件翻转。

## 测试口径

### 词表封闭（permission 包 types 测试）

- `MODE_KNOBS` 深等于 `["plan", "auto", "full"]`；反向穷尽检查为编译期断言。

### parse 矩阵（apps/cli parse-cli-args.test，表驱动）

- `--permission plan` / `auto` / `full` → 各值；缺省 → `undefined`；
- `--permission=full` 附值形态；
- 重复 flag 末次胜出（`--permission plan --permission full` → full）；
- 空附值 `--permission=` → 错误文案含词表（got ""）；
- 邻接 flag-like token 作值消费（arity 1 必取，与 `--mode`/`--thinking` 同语义）：
  `--permission -p` / `--permission --` → 枚举闭集报错（`got "-p"` / `got "--"`）；
  仅 argv 末尾裸 `--permission` → `option --permission requires a value`；
- 与位置参数混合（`--permission plan hello` → messages 收 hello）；
- usageText 断言完整词表行 `--permission <plan|auto|full>`（非仅 flag 名）。

### CLI 装配旅程（apps/cli 新文件 permission-flag.test，buildWorld 真装配 +
真实 dispatch，broker 非交互恒 deny 形态）

- **plan 腿**：dispatch write（界内）→ deny（reason `plan mode disallows write`）；
  dispatch bash 写面（`echo hi > new.txt`）→ deny（`plan mode: output redirect denied`）+
  只读命令（`git log --oneline`）→ allow（`classifier:readonly (plan)`——研究通道，
  2026-09-28 裁决：plan bash 由全拒改为**分类器只读放行**，写/未分类/注入/提权/重定向
  恒拒，见 bash/adjudicate.ts `planBash`）；
- **full 腿**：dispatch write 界内 → allow（`resolvedBy: "mode:full"`）且真写出
  tmp 文件；dispatch write 界外（路径避开 `**/.git/**` 等 deny glob）→ permission
  allow（mode:full）且真写出（总括授权根治后语义，docs/PERMISSION-FULL-UNRESTRICTED.md）；
- **deny 压过 mode**：full 档 dispatch write `<root>/.git/config` → deny
  （rule 压过 full，`rule:**/.git/**`）；
- **缺省锚**：不带 permission 的 buildWorld → 界内 write allow（`resolvedBy:
  "auto"`，与 full 的 mode:full 精确区分）+ 界外 write 走 ask → broker 恒 deny →
  deny（锁缺省非 full）。

### resume 负向（permission-flag.test，双 world + durable 会话）

- world A（`permission: "plan"`, persist）create 会话 → dispose；world B（不带
  permission）同 sessionRoot resume 该会话 → dispatch write 界内 → allow——
  「mode 不落会话档」的唯一行为锚。

### REPL reopen 保持（run-repl.test 补一条）

- `buildWorld({ permission: "plan" })` 的 REPL 发 `/new`（会话重建）后 dispatch
  write 仍 deny——reopen 不丢 mode 的不变量锚（与既有 /tools restriction 重演
  矩阵同构）。

### e2e 真进程腿（packages/e2e/src/cli-journey.ts，覆盖 main.ts openWorld 折入——
进程内测试无法覆盖的唯一接线）

- 假 anthropic server 扩展 tool_use 剧本（content_block_start type tool_use +
  input_json_delta + stop_reason tool_use），agent loop 真执行工具、tool_result
  回流后第二轮请求；
- 腿 1（用法面）：`--permission bogus -p` → exit 2 + stderr 含
  `expected plan | auto | full`；
- 腿 2（生效面）：`--permission plan -p --mode json` + server 剧本回 write 工具
  调用（界内路径）→ exit 0 + JSONL 含 permission 行（verdict deny）+ 第二轮请求
  体含 write 的 tool_result（is_error）+ done 恰末行。

### 回归

- 现有 parse / print-mode / kits / run-repl 用例不动即绿（缺省行为不变）；
- docs/CLI.md §2.1/§2.5/§2.6 同步为**人工验收项**（无自动锚，验收清单逐项勾）。

## 验收清单

- [ ] `--permission plan|auto|full` 三值解析 + 缺省 auto 行为不变（resolvedBy 锚）
- [ ] 垃圾值 / 缺值 / 空附值 → exit 2 中性英文文案（文案 join 生成）
- [ ] REPL 与 -p 两形态生效（REPL 经 reopen 保持锚）；resume 按当次 flag（负向锚）
- [ ] MODE_KNOBS 词表封闭断言 + 编译期反向穷尽在库
- [ ] usageText 与 docs/CLI.md §2.1/§2.5/§2.6 同步（人工验收）
- [x] full 档界外语义：根治后行为锚（真写出）+ CLI.md 写明（PERMISSION-FULL-UNRESTRICTED.md 同变）
- [ ] 四门全绿 + 覆盖率数字如实报告

## 审查处置（2026-09-20 定稿前双路审查）

- **full 档 PathGate 语义倒置**（契约面#1 / 测试面#2 同源发现）：核实属实
  （tool-plugin.ts extraRootsOf 唯一来源 ask grants）。裁决为存量缺陷挂账 +
  行为快照锚定 + 文档写明，不在本件改 PathGate/裁决序（涉 EXEC-ENV §5 已核销
  契约的独立裁决）。
- **fenceKit 测试装置**（契约面#2 / 测试面#7 同源）：fenceKit 无工具面 +
  sandbox probe 平台 fail-closed。裁决 harness kits 不加 fenceKit 用例（零平台
  依赖纪律），透传断言移至 apps/cli buildWorld 级 + e2e 真进程。
- **e2e 真进程腿**（测试面#1）：采纳——openWorld 未导出，进程内旅程无法覆盖
  main.ts 折入；假 server 扩 tool_use 剧本。
- **测试矩阵补强**（测试面#3/4/8/10/11/12）：缺省锚锁 resolvedBy、deny 压过
  mode 交叉、plan bash 拒、parse 四项边界、usageText 完整词表行、诚实 cast——
  全部采纳进测试口径。
- **resume 负向 / REPL reopen 锚**（测试面#5/6）：采纳。
- **文档同步面**（契约面#4/5）：补 §2.5/§2.6 + plan resume 静默放宽后果——采纳。
- **表述修正**（契约面#3/6/7）：print broker 括号收窄至 permission 裁决层并补
  网络 ask 面；「/model 式重建」矛盾表述改正；fenceKit 条件展开形态指明——采纳。

## 审查处置（2026-09-20 代码收口前双路审查）

核心链（词表→parse→buildWorld→fenceKit→plugin→dispatch→e2e 真进程）双路确认
无假绿、无双轨、缺省单一性成立（审查者实测：编译期穷尽断言 scratch 复现红、
e2e 腿对 main.ts 漏折的双红推演）。逐条处置：

- **方案措辞与实现同变**（契约面#1）：`--permission -p` 是 arity 1 作值消费 →
  枚举闭集报错，仅末尾缺 token 才 requires a value——本节上方测试口径已按实际
  形态改写。
- **e2e respondToolUse id 单调化**（契约面#2）：队列长度推导在复用时撞 id → 改
  全局单调计数器。
- **e2e 补强**（契约面#3 / 测试面#6）：tool_result 断言补 `"is_error":true`；
  permission 行补 reason 锚（plan 拒因钉在 JSONL 面本身）。
- **usageText 锚同源生成**（测试面#3）：断言期望串改 `MODE_KNOBS.join("|")`
  生成——扩档时用例红，提醒 usage 行同步（usage 文本保持静态模板风格，扩档时
  手改两处且漏改即红）。
- **reopen 用例提取自检**（测试面#4）：补 `restrictionOf(newId)` defined 断言
  （W2B 同款），id 切片静默错先红。
- **名实差用例删除**（测试面#5）：permission-flag.test 末位「parse 折入装配」
  用例实为 parse 三档值复测（类型对齐由 tsc 保证），删除。
- **门禁归属如实登记**（测试面#1 / 契约面#5）：main.ts openWorld 折入分支
  vitest 覆盖为零（进程内不可达），唯一行为锚是 e2e journeyPermission 腿——
  e2e 在 `bun run check` 完整链（四门外），流水线（T9 维护）需确认包含；
  覆盖率汇报如实标注。
- **不改项**（契约面#4/6）：usageText 静态模板与 `--mode <text|json>` 风格一致
  （残留由 join 生成锚兜底）；e2e message_delta 携带 input_tokens 是改动前
  既有装置形态，无 usage 断言面，不动。

## plan 模式完整流程（2026-09-28 增补——审批协议件）

> V3 架构注记：plan 档策略已插件化（docs/PERMISSION-V3-DESIGN.md）——permission 内置
> planDefaultMode（严格缺省：Write 拒 + bash 全拒），tool-plan 后注册 planMode（富策略：
> bash 只读放行/读保护基线/分类器三态）经 modeRegistry 同 id 后者胜覆盖。纯函数直调方
> （decideFor/adjudicateBash 无注册表）按旋钮映射内置件——plan 旋钮落严格缺省。

**工具执行矩阵（plan 档）**：read/grep 界内静默放行；**bash 分类器只读放行**
（`ls/cat/grep/find/rg/git 只读子命令/jq…`——argv 级分类 + 逐段旗面；写类/未分类/
注入/提权/输出重定向/解析失败一律 deny，未知即拒）；write/edit 无条件拒（先于规则）；
控制动词默认拒 + plan 插件白名单；其余未登记工具 ask。对照 pi 的行首正则白名单：
不学其可绕形态，走既有 argv 级分类器（auto 档同源）。

plan 档从「只读硬闸」补全为完整工作流，三面就位：

- **模型侧告知（权限档快照）**：facts 快照插件（@x-harness/harness
  `createFactsSnapshotPlugin`）第四条注册——kick 时点 tail snapshot
  （`kind="permission-mode"`），render 直读 `permissionMode` 服务当前值：plan 档注入
  行为指引（research read-only、勿尝试写、经 `plan_submit` 呈方案）；其余档渲染
  `Permission mode: <mode>.` 事实行——**恒渲染**使退出 plan 后新条 supersede 旧指引。
  permission 服务缺席（纯工具世界）→ 空串零注入。
- **审批协议（plan_submit 控制工具，@x-harness/tool-plan）**：plan 档的出口。方案文本
  经 permission broker 问用户（options=["once"]）；**批准 → 解档 liftTo**（宿主装配
  缺省档：CLI `sandboxed-auto` / hub 合并缺省——围栏姿势不因审批漂移）；**拒绝 → 留档
  refine**（合法结局非错误）。`isControlTool` 标记（permission 裁决直通——动词自身无
  环境副作用，不双重问询）。降级面：无 permission 装配 → 非 plan 档直接短路报错；
  plan 档但 broker 缺席 → 「有闸无门」明确报错，不静默解档。宿主经
  `planKit({ liftTo })`（@x-harness/harness）装配。
- **宿主切换面**：hub 既有 `permission/set_mode`（meta 持久化 + 服务即时切）；CLI 新增
  `/plan` slash（permissionMode 直切内存态——下一裁决即用新档；**会话内有效，CLI resume
  不折叠档位是已知面**，hub 无此缺口）。
- **委派子代理面（对抗审查 R1/R2 处置）**：plan 档是用户在主会话设的 world 级姿态——
  子代理（lineage depth>0）不得解档（plan_submit 拒绝 `delegated-session`，审批通道
  不触）；权限档快照对子会话渲染**子代理变体**（事实行 + 交付指向，不含「等用户批准」
  指引——无用户语境）。`liftTo` 不变量：解档目标绝不取 plan（宿主规范化：CLI 回
  sandboxed-auto / hub 回 auto；插件层误配回退 auto——`--permission plan` 启动形态下
  不再假解档/单向门）。拒绝语义（用户裁决）：deny → `concludesTurn` 收轮等指示——
  用户下一条消息有内容就带续、没有即终止，工具不自动 refine。plan 档 + 非交互
  （`-p`/管道）启动 fail-fast exit 2（无审批通道不成死胡同）。workflow submit 在
  plan 档被拒（acceptance.command 是变更面——R1-F5 单闸在提交入口，模型/人类两
  入口同漏斗）。

装配序：planKit 紧随 fenceKit（两宿主写死）；plan_submit 服务面 execute 期懒解析
（broker 是宿主提供件——与 permission 插件内部同款 tryUse 时点，无插件序耦合）。

测试口径：tool-plan 五路 execute 分支（非 plan 档/无服务/有闸无门/批准解档/拒绝留档）
+ isControlTool 标记 + broker 载荷形状；harness 权限档快照 render 两态 + isSnapshotNode
闭环；CLI slash 闭集十二命令 + /plan 分派。
