# PERMISSION V4 设计基线——permission 纯机制化 + 内置模式独立包

> 状态：定稿（实施中）
> 上游：PERMISSION-V3-DESIGN.md（U1-U8 沿用）；V4 = V3 的完成形——base 零策略。

## 0. 目标

V3 留下的尾巴：permission 包内仍持 fullMode/planDefaultMode 注册 + **回退梯本身是 auto 族策略**（in-root 放行/confirm-all 问/界外 ask/on-failure 围栏代问/分类器尾段三态）。V4 把这一切迁出：

- **permission = 纯底层机制件**：解析/分类器/规则引擎/grants/敏感面/facts/注册表/ask-审计执行/红线。**零档位策略**——无模式装配时，未显式放行（规则/习得）的一切 → ask（fail-closed 终态）。
- **@x-harness/permission-modes = 五档内置模式插件包**：full/auto/edit-confirm/sandboxed-auto/plan-default 全部显式插件化（完成 U6 当初否决的「插件全量声明」——当时否决因无独立包，今有）。
- tool-plan 的 planMode 富策略仍经注册表覆盖 plan-default（V3 机制不变）。

## 1. ModePlugin V4 协议（扩展）

```ts
interface ModePlugin {
  readonly id: string;
  /** 短路面（规则引擎之前——full/plan 形态：解析失败/提权/整线策略） */
  decide?(facts): Decision | undefined;
  /** 尾段姿态（规则引擎与段梯之后——auto 族形态：分类器三态/opaque 围栏代问/界内放行） */
  posture?(facts): Decision | undefined;
  readonly unrestricted?: true;
}
```

两挂点由 base 在固定位置调（时序契约）：bash 面 `decide` 在 deny 规则后/段梯前，`posture` 在段梯后/终态前；path 面 `decide` 在 deny 规则后/ask 规则前，`posture` 在 allow 规则后/界外终态前；tool 面仅 `decide`。

## 2. base 策略净化清单（迁出物）

| V3 位置 | 语义 | 迁往 |
|---|---|---|
| decide.ts in-root 放行（allowDecision "in-root"/"auto"） | auto 读姿 | autoMode.posture（editConfirm/sandboxedAuto/plan 读面复用） |
| decide.ts confirmAllWrite ask | edit-confirm 姿 | editConfirmMode.posture |
| decide.ts 界外 ask+grant | 缺省策略 | **base 终态保留**（grant 机制 + P-bug-3/4 修正随行——fail-closed 终态的富化，非档位语义） |
| adjudicate.ts pipelineTail 分类器三态 | auto 族姿 | 各模式 posture |
| adjudicate.ts opaque on-failure+fenced allow | sandboxed-auto 姿 | sandboxedAutoMode.posture |
| adjudicate.ts unclassified on-failure allow | sandboxed-auto 姿 | 同上 |
| modes.ts fullMode/planDefaultMode/builtinDecideOf | 内置件 | permission-modes（knobDecideOf） |
| plugin.ts 内置注册 | | permission-modes plugin |

**base 保留的终态**（策略无关 fail-closed）：unknown-tool ask / 界外 ask（含 grant 机制）/ opaque ask / unclassified ask（"no rule matches segment" + suggestedRule 机制）/ 解析失败 ask。

## 3. 纯直调方（U11：注入式依赖模式包）

- decideFor/adjudicateBash 的 `modeDecide` 入参扩为 `modeDecide`（短路面）+ `postureDecide`（尾段面），均 optional；
- permission-modes 导出 `knobDecideOf(profile)` → `{decide, posture}`（旋钮映射——custom profiles 行为保持的承接面）；
- plugin.ts（base）执行面：`registry.resolve(mode)` ?? `profileDecideOf` token（base 定义 token、permission-modes provide——base 消费服务不持策略）；
- 直调方（tool-write 抢救件/单测 helpers）：注入 `knobDecideOf(profile)` 或装配 permission-modes。

## 4. exec 归一（随行简化）

模式 decide/posture 返回的 allow 不带 exec——base 在 decideFor 出口统一 `execOf(verdict, profile)` 附加（机制：containment 是事实非策略；P-dup-6 的单源收敛）。

## 5. 用户裁决（V4）

| # | 裁决 |
|---|---|
| U9 | permission-modes 独立包（依赖 permission） |
| U10 | 回退梯全迁模式包——base 零策略，无模式装配=未显式放行皆 ask |
| U11 | 纯直调方注入式依赖模式包（knobDecideOf/token），base 不持旋钮映射 |
| U12 | 直接叠加开工（V3 未提交 ~52 文件保持） |

## 6. 不变量（V3 五红线沿用 + 时序契约）

红线 1-5 不变；新增：**两挂点时序是 base 与模式插件的契约**（decide 在规则引擎前仅对「整线策略」模式有意义——full/plan；posture 在段梯后——auto 族；一个插件通常只实现其一）。

## 7. kind 三分类（2026-09-28 裁决）

**kind = 工具风险分类（闭集），不是参数域命名、更不是工具名映射**。此前 `ruleTool`（内核持工具名映射表）
→ 开放词汇 kind（内核路由已知串）两版都有同源缺陷：词汇混入工具名/方言名。终版：

| kind | 语义 | 裁决模型 | 规则前缀 |
|---|---|---|---|
| `Read` | 只读工具（read/grep/自定义 reader） | 文件路径面（glob 规则 + 根集） | `Read(glob)` |
| `Write` | 写工具（write/edit） | 文件路径面 | `Write(glob)` |
| `Danger` | 行为不可静态分类需逐次裁决；**契约 = 参数含 `command` 串**（bash/shell 类） | 命令语言管线（tree-sitter 解析；方言是实现细节，非 bash 方言解析不动 → unparseable ask fail-closed） | `Danger(cmd prefix)` |
| 缺席 | 业务工具（Http 类）不声明 | 通用面：`Tool(名)` 通配规则 + fail-closed ask；细粒度规则归上层按工具名判断 | `Tool(名)` |

- **Grep 并入 Read**：拒读基线 `Read(**.env):deny` 跨工具覆盖 grep/自定义 reader；基线表/重定向拒读表随之单一化（`Read|Grep` 双过滤删）。
- **Bash → Danger 断代**（U2 先例）：规则前缀 `Bash(...)`/`Grep(...)` 不再解析（解析器 TOOLS 闭集 `Danger|Read|Write|Tool`，旧串 throw）；设置文件需迁移。未来 zsh 工具声明 `kind: "Danger"` 即入同管线。
- **Danger 契约执法**：`args.command` 缺席/非串 → 内核 fail-closed ask（`danger:command-absent`）——非命令串的危险工具不得声明 Danger（走通用面）。
- **闭集类型**：`ToolDefinition.kind?: "Read" | "Write" | "Danger"`、`RuleTool = "Danger" | "Read" | "Write" | "Tool"`（声明期类型收口，拼写错误编译即断——旧开放词汇靠运行时 fail-closed 兜底）。
- 模式策略统一写在分类轴：permission-modes 消费 `facts.kind`（`face === "bash"` 判别在可达策略面改为 `kind === "Danger"`——modes.ts 全量、plan-mode.ts 保留 face 门控作事实形判别，双射在全部生产构造点成立；face 仍是事实形标识——segments/roots 只在命令面存在）。

### 7.1 依赖环切除（同日）

`resolveProfile` 曾由 base 直接 import permission-modes——形成 workspace 依赖环（bun 嵌套安装消化）。切除：
base 定义第三 token `resolveProfileOf`（modes.ts，与 `profileDecideOf`/`baselineDenyRulesOf` 同式），
permission-modes provide；base 调用时 `tryUse` 懒取，服务缺席（裸内核）= 断代落 auto（U3，告警文案区分
「服务缺席或未知 id」）。permission 的 package.json 不再运行时依赖 @x-harness/permission-modes（devDependencies 保留——内核行为测试矩阵经内置模式件跑，属 L3 已知 dev 环）——
**依赖方向单向化：permission-modes → permission（tokens/类型），底层不识上层**。

## 8. 对抗审查修复（2026-09-28——8 子代理 117+ 攻击记录的处置记录）

**裁决点（承用户「修复」指令按推荐执行）**：
- **A① 红线 2 钳制**：硬拒/注入/解析失败事实在场时，模式 allow（任何第三方模式插件）内核改写为 ask（`red-line:floor`，拒记）——最小 ask 底线在内核不靠插件自觉。**总括档豁免（2026-09-28 用户裁决）**：unrestricted（full）档下灾难形态/注入/解析失败/拒写钳制让位放行——恒拒 = 提权面（模式件判决）与凭据目录拒读（~/.ssh 等任意位置，升格 deny）；.env 族是位置条件拒止（根集外），总括档授权根=[/] 即全盘根集，随总括放行；非总括模式插件钳制全量在场。
- **B① bash 面底线扩面**：重定向硬线（凭据目录输入拒读 deny 恒在场——总括档不放行；.env 族条件拒止同判；输出拒写 deny 非总括档——full 让位）置于模式判决前；敏感底线（argv+重定向目标）置于模式 allow 的钳制位（严格模式更强判决不被弱化；U16 显式 allow/U12 精确习得豁免保留；总括档仅凭据目录执法且升格 deny，.env 族随根集条件豁免）。
- **C① 安全底线词表内核化**（修正 V4 净化 #2）：baseline.ts 恒合并（origin "default"），凭据目录表（~/.ssh 等——任意位置拒止）与 .env 族条件表（仅工作区根集外——项目本地配置可读写，2026-09-28 裁决）分列（DEFAULT_DENY_READ / DEFAULT_DENY_READ_OUTSIDE）；分类器/五档/旋钮映射留 permission-modes。`baselineDenyRulesOf` token 删除。
- **D① ask 规则三面同序**：deny → ask → 模式 → allow → posture——「用户要问」不被档位整线放行吞。
- **E① escalate 一次性**：批准=重试一次，记忆梯度撤（旧四档落桶跨档 direct 免问且游离 memorizable 门/审计）。
- **G reply 契约校验**：memory 枚举外/多规则夹带/坏串只批不记。
- **H 卸载墓碑**：permission 卸载（tools 存活）留恒 deny 中间件——与「从未装配的裸 SDK 世界」（合法）区分。

**结构修复**：facesOf 面补齐（注册表覆盖件缺面经旋钮面补——planMode 丢 posture 的类修）；permissionAdjudicate 直调服务（抢救件单真相——customProfiles/注册表/底线全内聚）；旋钮桥收紧优先 + profileRowValid 拒矛盾组合；习得闸单源（MEMORY_BLOCKED_HEADS 内核导出，settleMemory 与 host 命令面同闸）；域名族/allowedDomains 死面删除；ToolKind 单源（core/tools）；check-kernel-deps 扩扫 permission 组（运行时单向成门禁）；readsSubtree 范围型读声明（grep 目录搜索的子树拒读：有锚相交 deny/无锚 ask+范围记忆/文件目标直读）；fence.writable 进路径面 roots；根归一双轨收敛；grant 归因真名（rule:user 硬编码消灭）。

**回归件**：adversarial-floor / scope-read / classifier-composition / knob-bridge / plan-posture / rescue-single-truth / control-flag-bypass（.adversarial/ 探针复跑验证后删除）。
