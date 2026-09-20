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
| **full 档路径工具界外的许可/执法两层语义** | **存量缺陷登记挂账**：permission 层 full 对界外 read/write/grep 返回 allow（decide.ts full 检查在界内判定前），但工具执行面的 PathGate.admit 其 extraRoots 唯一来源是 ask 批准落账的 grants（tool-plugin.ts extraRootsOf）——full 恰绕过 ask，grant 永不产生，界外路径实际 `PATH_ESCAPES_ROOT` 拒。净效果：auto 档经审批**可以**界外写、full 档反而**不可达**（能力倒置；bash 面不受影响，full 档 bash 可写界外）。根治需裁决 mode 是否下沉 PathGate 口径（涉 EXEC-ENV §5 已核销契约与 tool-core 执法层语义），独立件立项。本次：CLI.md 如实写明 + 集成测试钉住现状行为快照（permission allow mode:full + 执行层 PATH_ESCAPES_ROOT） |
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
- full 档界外路径工具语义按「存量缺陷挂账 + 行为快照锚定」处置（见「不处理」表），
  不在本件内改 PathGate/裁决序。

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
  dispatch bash（`echo hi`）→ deny（`plan mode disallows bash`）——plan bash 全拒
  首次入锚；
- **full 腿**：dispatch write 界内 → allow（`resolvedBy: "mode:full"`）且真写出
  tmp 文件；dispatch write 界外（路径避开 `**/.git/**` 等 deny glob）→ permission
  allow（mode:full）+ 执行层 `PATH_ESCAPES_ROOT`（挂账语义行为快照）；
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
- [ ] full 档界外两层语义行为快照入锚 + CLI.md 写明 + 挂账登记
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
