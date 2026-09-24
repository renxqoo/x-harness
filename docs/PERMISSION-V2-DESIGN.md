# PERMISSION-V2 设计基线（权限系统重构）

状态：**已实施（P1+P2 全量落地）**——两路独立对抗审查处置落档（§12）；实施记录与
行为变更矩阵见 docs/PERMISSION-V2-IMPLEMENTATION.md。本文是现行权限行为的单一真相。

现行权限文档（docs/EXEC-ENV.md §5/§6、docs/PERMISSION-FULL-UNRESTRICTED.md）
在重构合并后由本文取代；旧文档随对应波次落地时删除或改指向。

## 0. 背景与问题

现行实现的四个结构性问题：

1. **围栏拦进程不拦裁决**：sandbox 对全部允许执行的命令做 srt 包裹，再用
   `trustedCommands` 词表豁免 fence 打挂的应用（host-hub 硬编码 `["bw"]`）——
   合法应用开箱即坏，豁免要改代码。
2. **模式是代码枚举不是数据**：ModeKnob 三档（plan/auto/full）语义散在
   decide.ts 分支里，加一档（如「编辑需确认」）要动内核分支面。
3. **无授权记忆**：grants 只有 extraRoots/allowedDomains/unrestricted 三种
   会话内窄授权；同一命令每会话重复 ask——「不要每次点确认」没有机制支撑。
4. **规则面未暴露**：规则词汇表（parse/glob/bash-prefix）在包内完备，但
   host-hub 没有 settings 面，用户写不了 `Bash(git status):allow`。

## 1. 用户裁决清单（方向性决策，全部已落档）

| # | 裁决 | 内容 |
| --- | --- | --- |
| U1 | 删词表 | `["bw"]` 硬编码与 `trustedCommands` 概念整体删除；**包裹跟着裁决走** |
| U2 | 模式=配置 | 权限档位 profile 表数据化，加档=加行 |
| U3 | 授权记忆 | Claude Code/Codex 式：ask 批准可记忆为规则，多作用域生命周期 |
| U4 | 低摩擦 | 规则→记忆→安全分类→围栏代确认四级免问，ask 是最后手段 |
| U5 | 直通零 containment | host-hub 缺省档 direct 执行无围栏（Zcode 生产姿势）；**残余暴露面见 §4.3 消失防线清单（v2 新增，如实申报）** |
| U6 | CLI 保留围栏优先 | 两宿主同机制、不同缺省档：CLI=sandboxed-auto（Codex 姿势），host-hub=auto |
| U7 | contained 进 P1 | 围栏代确认 + on-failure 升级并入第一波 |
| U8 | 记忆默认本会话 | ask 弹窗缺省「本会话」；升级作用域手动改选 |
| U9 | 零挂账 | 自定义档位/非 bash 工具规则/CLI 配置面并入 P2；企业层出问题域（非挂账） |
| U10 | plan 硬闸（v2） | plan 是档位级硬闸：bash/Write 族在规则与记忆**之前**无条件 deny（恢复并维持现行语义）；Read/Grep 仍走规则。档位不再是纯「剩余部分缺省」——见 §3 步 2.5 |
| U11 | 硬底线口径钉死（v2） | 硬拒/注入类=**恒 ask 且无记忆选项**（与现行一致，不变更）；full 档硬拒面维持 PERMISSION-FULL-UNRESTRICTED 现裁决（sudo 类 deny + 用户 deny 规则拦，其余过）——零行为变更，纯口径钉死 |
| U12 | argv 敏感面防线（v2） | 直通档的内核防线消失用**裁决管线新执法面**补偿：argv 文件实参命中敏感读表/保护写面 → 强制 ask（精确规则可记忆，泛化建议只给精确形态）；env 不清洗申报为已知暴露面 |
| U13 | settings 完整性（v2） | hub-settings 文件路径进保护路径（工具面 deny + 围栏档内核面双挡）；学习写入只走命令面；规则存储结构化带 origin |
| U14 | 升级触发器结构化（v2） | on-failure 触发=fenceSuspect 结构化标记（sandbox 执行器归因），弹窗必须展示失败原文+命令；残余伪造面如实申报（用户是最终裁判） |
| U15 | 执行矩阵显式化（v2） | 执行指令 = f(裁决类, 档位, 升级态)——§4.2 矩阵表是唯一真相，梯子文本与矩阵冲突时以矩阵为准 |
| U16 | 梯序维持（v2） | 结构失败/动态段 ask 先于 allow 规则（现行序）；opaque 可被显式 allow 委任但**永不可被习得/泛化委任**；习得拒写集=硬拒+注入+结构失败+动态段+opaque 泛化形态 |
| U17 | override 恒围栏（v2） | delegation worktree 隔离会话（rootOverride）恒 contained，不受档位 containment 影响——隔离是子代理契约不是权限偏好 |
| U18 | session 记忆生命周期（v2） | session grant=进程内存；WAL 事件仅审计非授权重放源；resume 不复活（与现行 grants 一致）；fork 不复制授权桶 |
| U19 | 指令送达与通道归属（v2） | exec 指令经 dispatch 载荷服务端透传（tools 契约扩展）；工具内部 spawn（rg 等）按档位 containment；bash-exec 用户直启通道=恒 direct 不过 decideFor（用户自发动作，现行同姿势，申报） |

## 2. 四分离架构

| 概念 | 回答的问题 | 形态 | 载体 |
| --- | --- | --- | --- |
| Rules（策略） | 这类操作**永远**怎么处理 | 规则条目（pattern+verdict+origin），模式匹配 | settings 文件（user/project） |
| Grants（记忆） | 用户**批准过**什么 | origin="grant" 的规则条目 + 作用域/生命周期 | session（进程内存）/ project / user（settings 文件） |
| Mode（档位） | 未命中的**剩余部分**缺省怎么办（plan 硬闸除外，U10） | PermissionProfile 一行（旋钮束） | profile 表（出厂内置 + P2 用户行） |
| Enforcement（执行） | 裁决怎么落地 | 执行指令 direct/contained | sandbox env spawn |

**单一裁决中心不变**：全部裁决在 @x-harness/permission；sandbox 是执行器，
只消费指令不做策略；围栏授权事实（域名/unrestricted）仍归 grants。

**Grants 不是第二套机制**：记忆=origin 标记的规则条目，与手写规则同一解析器、
同一匹配引擎、同一存储文件；差异只在写入路径（命令面 vs 手编）与生命周期。
**规则存储结构化（U13，v2 修订）**：`permission.rules` 为
`{ pattern: string; verdict: allow|ask|deny; origin: "handwritten"|"grant"; at?: number }[]`
——文件位置示别作用域（user/project），字段示别性质（手写/习得）；RuleOrigin
词表随之扩展。纯字符串规则形态仅存在于规则串语法层（`Bash(git status):allow`
解析入存储时即结构化）。

## 3. 决策管线（每次工具调用，单点 decideFor）

```
1 解析         tree-sitter bash AST / 路径参数（单一解析真相——沿用现资产）
2 结构防线     结构失败/动态展开段 → ask（先于一切 allow——现行序，U16）
2.5 档位硬闸   plan 档：bash/Write 族无条件 deny（先于规则/记忆，U10）
               Read/Grep 继续走 3-5
3 硬底线       hard-deny + 注入检测 → 恒 ask 且无记忆选项（U11；full 档维持
               现口径：sudo 类 deny、其余过）
4 规则匹配     作用域合并（显式+习得同遍）→ allow / ask / deny
               显式 ask 命中 → ask 且**抑制记忆选项**（提示受显式规则约束）
5 记忆命中     origin=grant 条目匹配 → allow（resolvedBy=grant@scope）
6 模式缺省梯   安全分类器（§4.4——P1 显式交付物）：
                 只读类/界内合成写 → 按矩阵执行指令
                 argv 敏感面命中（U12）→ 强制 ask（精确可记忆）
                 未分类 → 按矩阵（contained 或 ask）
7 ask          记忆梯度：[这次][本会话(缺省 U8)][本项目(建议规则)][始终][拒绝]
               泛化建议器受 §5.2 边界约束
               批准 → 写最窄建议规则进所选作用域 + 按矩阵执行
8 审计         permissionDecided（带指令与命中来源）
```

**匹配优先序（安全向）**：deny（任意作用域）> 显式 ask > 习得 allow > 显式
allow > 模式缺省。习得规则只有 allow 一种 verdict；显式 ask 压过习得 allow——
学习永远不越过用户显式写下的「要问」。

**on-failure 升级流（时序契约，v2 修订 U14）**：contained 执行失败 → 工具
结果带 `fenceSuspect`（sandbox 执行器对包裹路径失败按围栏拒绝签名归因的结构
化标记，判定归执行器单点）→ harness 发起 escalate ask（**必须展示失败原文
与完整命令**）→ 批准 → 同一命令 direct 重执行**一次**（缺省不写规则；记忆
选项在场，缺省本会话）→ 拒绝 → 失败定案。**配额键 = 命令文本哈希 per
session**（防同文本重试刷弹窗；升级段复用原槽位，abort 语义同现行竞速面）。
残余伪造面申报：fenceSuspect 归因含文本启发成分，恶意命令可自印相似形态——
弹窗材料齐全（原文+命令+审计因果）时用户是最终裁判，此残余面接受。

## 4. 档位系统

### 4.1 PermissionProfile

```ts
interface PermissionProfile {
  readonly id: string;
  readonly askPolicy: "never" | "on-failure" | "on-opaque" | "always";
  readonly containment: "none" | "fenced";
  readonly mutationPolicy: "plan-deny" | "confirm-all" | "auto-in-root"; // v2：三值（plan 硬闸独立表达）
}
```

出厂五档：

| id | askPolicy | containment | mutationPolicy | 缺省宿主 |
| --- | --- | --- | --- | --- |
| plan | always | none | plan-deny | —（硬闸档，U10） |
| auto | on-opaque | none | auto-in-root | **host-hub（U6）** |
| edit-confirm | on-opaque | none | confirm-all | — |
| sandboxed-auto | on-failure | fenced | auto-in-root | **CLI（U6）** |
| full | never | none | auto-in-root | — |

- 档位运行时可切（permissionMode 服务面沿用）；切离 full 即时撤 unrestricted
  （现行原子同步语义维持）；session 记忆不因切档回溯失效。
- **自定义档位（P2，U9）**：user/project settings 写 profile 行即成一档；
  出厂 id 保留名不可 shadow（重名拒）。自定义行组合约束：`containment=fenced`
  与 `askPolicy=always` 合法（围栏内跑+弹窗确认）；无非法组合需排除。
- ModeKnob 类型被 ProfileId 取代（零兼容层，一次切净；CLI `--permission`
  值域校验、fenceKit 签名、host-hub 值域四副本同步扩——P1 必改项）。

### 4.2 执行指令矩阵（U15——唯一真相；梯子文本与矩阵冲突时以本表为准）

f : (裁决类, 档位 containment, 升级态) → direct | contained | ask | deny

| 裁决类 | containment=none（auto 系/full） | containment=fenced（sandboxed-auto） |
| --- | --- | --- |
| 结构失败/动态段 | ask | ask |
| 硬拒/注入 | ask（无记忆选项；full 维持现口径） | ask（无记忆选项） |
| 显式/习得 allow | direct | contained |
| argv 敏感面命中 | ask（精确可记忆） | contained（围栏内执法，不问） |
| 安全只读类 | direct | contained |
| 界内合成写（mutationPolicy=auto-in-root） | direct | contained |
| 界内写（mutationPolicy=confirm-all） | ask | contained |
| bash/Write 族（mutationPolicy=plan-deny） | deny（硬闸，先于规则） | deny（硬闸） |
| 未分类 opaque | ask（on-opaque/always/never≠此格） | contained（on-failure：不问先围栏） |
| 未分类不可围栏形态 | ask | ask |
| contained 失败 + fenceSuspect + 未升级过 | escalate ask → 批准后 direct ×1 | 同左 |
| unrestricted（full 授权） | direct（总括覆写） | direct（总括覆写） |
| rootOverride 会话（U17） | —（恒 contained） | contained |

askPolicy 语义在此矩阵下良定义：`never`=未分类行不产生 ask（full 全 direct，
由 unrestricted 覆写行表达）；`on-failure`=未分类先 contained，失败才 ask；
`on-opaque`=未分类不可围栏形态 ask、可围栏形态 contained；`always`=一切
未分类 ask（升级档用的严格位）。

### 4.3 直通档消失防线清单（U5 如实申报 + U12 补偿，v2 新增）

现行 auto 档「全包裹」下由内核执法、直通后消失的防线，逐条处置：

| 消失防线 | 处置 |
| --- | --- |
| argv 文件实参拒读（`cat ~/.ssh/id_rsa` 类） | **补偿**：裁决管线新执法面（§3 步 6 敏感面 ask，U12）——DEFAULT_DENY_READ 表复用 |
| 重定向/argv 保护写（`.git/hooks` 等） | **补偿**：同上（保护写面=DEFAULT_DENY_WRITE+protectedPaths） |
| env 清洗（scrubEnv 密钥键） | **申报放弃**：direct 档不清洗（bw 依赖 env 通道的既定事实；Zcode 同姿势）——已知暴露面 |
| 网络域名白名单/逐域 ask | **申报放弃**（直通档）：allowedDomains 授权面仅在 fenced 档活；域名问询面随之死亡，文档标注「死配置仅 fenced 档生效」 |
| fs 拒绝面（界外写读） | **部分补偿**：argv 敏感面补偿读/写底线；界外一般路径回归 ask/规则面 |

### 4.4 安全分类器（P1 显式交付物，v2 新增）

「只读类」分类器是**全新部件**（现行资产无此词表——auto-allow 唯一来源是
围栏在场界内合成写）。规格：argv0 白名单动词法（git status/ls/cat 级），
**fail-closed**——未知动词不得分类为只读；写副作用动词白名单方可入类；
对抗用例钉死（`find / -delete`/`dd`/`tar -x` 不得入只读类）。词表归属
permission 包（数据文件），P1 交付并给验收矩阵。

## 5. 授权记忆系统

### 5.1 作用域与生命周期

- **session**：进程内存（授权桶）；WAL 仅记审计事件，**非授权重放源**（U18）
  ——resume 不复活、fork 不复制授权桶（新会话新桶）；死亡判据=world/session
  dispose（现行 grants「resume 不继承」语义维持）。
- **project**：`<cwd>/.x-harness/hub-settings.json`（trusted 门禁沿用；
  **非 trusted 工作区学习写 project → 降级 session 并提示**）。
- **user**：`~/.x-harness/hub-settings.json`。

### 5.2 写入与泛化边界

- 写入路径唯一：ask 弹窗批准（U8 缺省 session）或 `permission/grant` 命令面；
  **settings 文件不经命令面不可写授权**（U13——文件本体受保护路径双挡）。
- 学习写入统一校验面：规则形态 fail-closed + NEVER_MEMORIZE 拒写集
  （**U16 扩容**：硬拒+注入+结构失败+动态段命中命令一律拒写）+ 泛化形态
  边界 + 作用域合法（session/project/user 三值；plan/override 会话只可写
  session）。
- **泛化建议器边界（v2）**：仅对「字面 argv0+字面子命令」形态泛化
  （`npm install x` → `Bash(npm install:*)`）；wrapper（`bash -c`/`env`/
  `sudo` 前缀）、解释器字符串载荷（`node -e`/`python -c`）、opaque 形态
  **一律不泛化**——只允许精确匹配或不建议。
- 路径工具记忆=extraRoots grant（会话）+ Write glob allow 规则（持久档），
  归并统一审计/管理面。

### 5.3 管理面（P2）

学习规则列表/删除/按作用域清空（按 origin 字段筛选）；每条带 origin+落档
时间；「重置本项目权限」。

## 6. 外部契约

### 6.1 执行指令贯通（tools/sandbox 契约扩展）

- `PreExecuteDecision` 扩展：`verdict` + `exec`（`direct|contained`）+
  `reason/resolvedBy` + `grant?` + `fenceSuspect?`（升级态用）。
- **指令送达通道（U19，v2 补全）**：dispatch 载荷新增 exec 指令字段（tools
  契约扩展：preExecute 决策由 dispatch 服务端合入调用上下文）→ 工具执行期
  从 ctx 读指令构造 `SpawnRequest`；**模型入参不可达**（与 payload.session
  同一服务端独占面）。
- `SpawnRequest` 扩展：服务端指令字段；**工具内部 spawn（rg 等）按档位
  containment 取缺省值**（none→direct / fenced→contained）。
- **bash-exec 用户直启通道（U19）**：用户自发直启+confirm=恒 direct，不过
  decideFor（现行同姿势，申报为设计而非遗漏）；world 拆卸期在飞直启命令
  独立存活语义维持（detached 进程组）。
- sandbox env spawn：contained 走 srt 包裹（现路径原样），direct 走直通
  （现 unfenced 路径原样）；`trustedCommands` 词表面删除。
- unrestricted 恒 direct（总括覆写）；**rootOverride 会话恒 contained
  （U17）**——两个覆写点 + 升级单次 direct（§3）是全部例外，不变式 §9.5
  措辞以此为准。

### 6.2 ask 往返契约（v2 新增，U13/U14 承载）

`AskRequest`/broker 返回值从布尔扩展为结构化（permission 包契约变更）：

```ts
interface AskPayload {
  readonly tool: string;
  readonly reason: string;
  readonly options: readonly ("once" | "session" | "project" | "user")[]; // 按命中类裁剪：硬拒/显式 ask/结构失败=[once]
  readonly suggestedRule?: string;      // 泛化建议（§5.2 边界内；可被用户改写）
  readonly escalate?: { readonly failureText: string; readonly command: string }; // on-failure 升级语境
}
type AskReply = { readonly verdict: "allow" | "deny"; readonly memory?: "session" | "project" | "user"; readonly ruleOverride?: string };
```

host-hub UI confirm 协议（dialogs）与 CLI broker 同步扩形态；AskPayload 由
decideFor 产出（`memory?` 字段挂裁决返回值，消费方经 broker 输入侧取用——
链路闭环）。

### 6.3 settings 面（host-hub，走既有单点校验）

| 键 | 形态 | 说明 |
| --- | --- | --- |
| `permission.defaultMode` | ProfileId（已有，值域扩五档） | 装配初值 |
| `permission.rules` | RuleEntry[]（§2 结构化） | 合并语义：**跨层并集，同 pattern 后写覆盖 origin**；校验含 origin/at 形态 |

- **保护路径接线（U13，P1）**：两 settings 文件路径进 permission
  protectedPaths + DEFAULT_DENY_WRITE 面（工具面）；fenced 档下同步进 fence
  denyWrite（内核面）。
- 命令面：`permission/grant`（学习写入，P1）、`permission/set_mode|get_mode`
  （现行，值域扩）、`permission/rules`（列表/删除——P2）。

### 6.4 审计事件

`permissionDecided` 扩展（**P1 落地**，v2 修订归属）：`exec` 指令 +
`resolvedBy` 细分（rule@scope / grant@scope / profile-default / hard-deny /
injection / argv-sensitive / classifier）。新增 `permissionGrantWritten`
（作用域+规则串+来源命令摘要）与 escalate 因果（fenceSuspect 标记+原文）。

## 7. 内部问题域边界（明确不处理 + 归属）

| 不处理 | 归属 |
| --- | --- |
| 企业/组织策略层 | 问题域外（U9，非挂账）——多租户需求出现时另立项 |
| bash 解析器/hard-deny/injection 词汇表内容升级 | 不动——资产原样承重（**梯序与拒写集扩容除外，U16——是裁决序不是词汇表**） |
| sandbox 执行器内部（srt wrap 细节） | 不动——仅增 fenceSuspect 归因单点 |
| delegation 子代理权限模型（继承会话权限） | 现状维持 + override 恒 contained（U17） |

## 8. 并发与性能预算

| 预算 | 数字 | 备注 |
| --- | --- | --- |
| 单次裁决热路径（含 AST 解析） | ≤ 5ms | 热路径纯 CPU；bench 用例守上界（CI 松门 ×10） |
| 规则+记忆合并匹配 | ≤ 0.5ms | 作用域合并后单遍；RuleEntry 结构化不增复杂度 |
| AST 解析缓存 | per-command LRU（512） | 同命令重复裁决免重析 |
| 审计事件 | 异步不阻塞裁决返回 | 沿用事件桥 |
| on-failure 升级 | 配额键=命令文本哈希 per session，至多一次 | 契约级（§3） |
| ask 超时 | 沿用 CONFIRM_TIMEOUT_MS | 不变 |

## 9. 安全不变式（测试必须逐条钉死；v2 扩容）

1. NEVER_MEMORIZE：硬拒/注入/结构失败/动态段命中命令不可被记忆（拒写集，
   U16），ask 弹窗只余 [once]；显式 ask 命中同样抑制记忆选项。
2. deny 跨作用域压过一切 allow/ask；显式 ask 压过习得 allow；习得规则只有
   allow 一种 verdict。
3. 学习写入统一过校验面：形态 fail-closed + 拒写集 + 泛化边界（wrapper/
   解释器载荷/opaque 不泛化）+ 作用域合法（三值；plan/override 只 session）。
4. 执行指令仅服务端管线可设（dispatch 载荷透传面）；模型/工具入参不可伪造。
5. direct 覆写点封闭集：unrestricted（full 总括）、rootOverride 反向（恒
   contained）、升级批准单次 direct——此外无路径产生档位外 direct。
6. plan 硬闸：bash/Write 族 deny 先于一切规则/记忆/授权（U10）。
7. session 记忆不随 resume/fork 复活或复制；切离 full 即时撤 unrestricted。
8. settings 文件对 Write/bash 为保护区（工具面 deny + fenced 档内核面）；
   授权写入唯一入口=命令面。
9. 安全分类器 fail-closed：未知动词不得入只读类（对抗用例钉死）。

## 10. 波次（U7/U9 + v2 边界重划；实施顺序与测试计划归 IMPLEMENTATION，审计后定稿）

- **P1**：决策梯重排（§3 八步）+ profile 表 + 执行矩阵 + 执行指令贯通
  （PreExecuteDecision/SpawnRequest/dispatch 送达/sandbox 词表删除）+
  contained/on-failure 升级（fenceSuspect 归因 + 配额键）+ 授权记忆三作用域
  （结构化 RuleEntry + 命令面写入 + 校验面）+ ask 结构化往返（AskPayload/
  AskReply + host-hub dialogs + CLI broker）+ 泛化建议器（边界内）+ host-hub
  settings 面（defaultMode 五档 + rules + protectedPaths 接线）+ **安全
  分类器（词表+fail-closed）** + CLI `--permission` 值域/fenceKit 签名/
  host-hub 值域四副本同步 + `permissionDecided` 扩展字段 + argv 敏感面执法 +
  两宿主缺省档接线（host-hub=auto、CLI=sandboxed-auto）。
- **P2**：学习规则管理面（列表/删除/清空）+ 审计对账收口 + 自定义档位
  （settings 写 profile 行）+ 非 bash 工具规则粒度（WebFetch 域名/浏览器面）
  + CLI 配置面（rules/档位 flag 与 config 暴露）。

两波收口，除 §7 问题域边界外零挂账。每波：四门全绿（覆盖率只升不降）+
独立会话对抗审查（对照旧实现行为基线）+ 本文档同变。旧实现行为规格基线
在审计后落 MIGRATION 文档（**含 §11 申报的行为变更清单**），逐单元核销。

## 11. 行为变更申报（相对现行实现；MIGRATION 逐条落矩阵）

| 变更 | 性质 |
| --- | --- |
| host-hub auto：全包裹 → 分类直通 | **用户裁决 U5**（补偿面见 §4.3） |
| argv 敏感面：内核静默拦 → ask | 新执法面（U12），交互增、防线等价 |
| ask 弹窗：单按钮 → 梯度+建议 | 新能力（U3/U8） |
| 词表删除（["bw"]/trustedCommands） | 用户裁决 U1（bw 走直通自然工作） |
| fenceSuspect/审计扩展 | 纯增观测面 |
| 硬底线/full 口径 | **零变更**（U11 钉死，仅文案） |
| plan 语义 | **零变更**（U10 恢复并钉死现行硬闸） |

## 12. 对抗审查处置表（v2 收口记录）

两路独立审查（架构/契约 + 安全/语义）合并去重后 6 阻断 + 10 应修 + 6 可留，
全部处置如下（编号=审查报告合并项）：

| 合并项 | 处置 |
| --- | --- |
| 执行矩阵不良定义（A1+B5） | U15：§4.2 矩阵为唯一真相 + f(裁决类,档位,升级态) |
| plan 被规则击穿（B1+A9） | U10：硬闸先于规则/记忆；§9.6 不变式 |
| 直通档防线消失瞒报（A2+B2） | §4.3 消失防线清单 + U12 argv 补偿 + env/网络申报放弃 |
| 围栏签名可伪造（B3+A7） | U14：fenceSuspect 结构化归因 + 弹窗材料强制 + 残余面申报；配额键=文本哈希 |
| settings 自授权面（B4） | U13：保护路径双挡 + 命令面唯一写入 + 结构化 origin（A3 同处置） |
| ask 交互契约缺席（A4） | §6.2 AskPayload/AskReply 契约新增 |
| 硬底线 deny/ask 矛盾 + full 冲突（A5+B10） | U11：恒 ask 无记忆（现行一致）+ full 维持现口径 |
| 安全分类器不存在（A6+B13） | §4.4 P1 显式交付物 + fail-closed 不变式 §9.9 |
| SpawnRequest 送达/非 bash/直启（A8+B14） | U19：dispatch 载荷通道 + 档位缺省 + 直启恒 direct 申报 |
| rootOverride 缺失（B6） | U17：恒 contained；§4.2 矩阵行 |
| 泛化边界/拒写集（B7+B12） | U16：§5.2 边界 + 梯序维持 + 拒写集扩容 |
| 升级配额/竞速（B8） | §3 配额键定义 + 槽位语义 |
| session WAL 语义（A10+B9） | U18：内存权威、WAL 仅审计、resume/fork 不复活 |
| P1/P2 边界（A11） | §10 v2 重划（CLI 值域/审计字段/分类器/保护路径前移 P1） |
| 显式 ask 死记忆（A12） | §3 步 4 抑制记忆选项 |
| settings merge/降级/路径记忆（A13） | §6.3 并集覆盖语义 + §5.1 降级规则 + Write glob 持久形态 |
| invariant 5/6 措辞（B11） | §9.5 覆写点封闭集 + §9.7 拆分 |
| fenceFacts 存废（B16） | fenced 档维持（界内合成写判定输入）；直通档缺席即分类器接管（§4.4） |
| 措辞冲突（A14/B15） | 全文统一（U1「allow 直通」限定直通档；升级记忆缺省=本会话） |

## 13. 验收面（收口核销条件）

- 执行矩阵全格 × 五档 profile × 记忆作用域的行为矩阵测试全绿；
- **自定义档位**：settings 写行生效、出厂保留名重名拒、管理面可删（P2）；
- **非 bash 工具规则**：WebFetch 域名面 ask/deny/记忆矩阵（P2）；
- **CLI 配置面**：rules/档位经 config 与 flag 生效，装配缺省 sandboxed-auto；
- on-failure 升级流端到端（contained 失败 → fenceSuspect → escalate ask 带
  原文 → direct 重执行一次 → 配额拒二次）；
- §9 九不变式逐条有对抗用例；
- host-hub 集成：settings 规则生效、ask 梯度往返、学习规则落盘可复用、
  settings 文件写保护生效（Write/bash 双面试探拒）；
- CLI 集成：sandboxed-auto 档与现行为等价面（包裹/网络白名单/rg 包裹）
  迁移矩阵逐条核销；
- `["bw"]` 与 trustedCommands 全仓零残留（含文档）；
- 四门 + 覆盖率 ≥90/85 只升不降；假绿对抗抽查通过。
