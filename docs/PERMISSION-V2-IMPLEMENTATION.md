# PERMISSION-V2 实施工录（对应 docs/PERMISSION-V2-DESIGN.md v2）

状态：**P1+P2 一次全量实施完成**（用户裁决 U9 零挂账）。本文记录裁决表、测试口径与
行为变更矩阵；旧实现行为基线=实施前 git HEAD 的 permission/sandbox 测试语义。

## 1. 模块裁决表

| 旧模块 | 裁决 | 说明 |
| --- | --- | --- |
| permission/bash/ast+injection+hard-deny+wrappers | 保留原样 | 解析/注入/硬拒/剥离资产承重（U16 梯序维持） |
| permission/decide.ts | 重写 | 档位 profile 化 + 执行指令输出 + 通用 Tool 规则面 + edit-confirm |
| permission/bash/adjudicate.ts | 重构 | 八步梯（结构→plan 硬闸→硬底线→规则→敏感面→习得→opaque→分类器）；段级 rule-allowed 终结 |
| ModeKnob 三档枚举 | 删除 | ProfileId 五档 + profiles.ts 数据表（加档=加行）；host-hub/CLI 值域同步 |
| grants.ts 会话规则 | 扩展 | addRule（习得桶）+ 拒重；resume/fork 不复活维持 |
| — | 新建 | classifier.ts（三分类，fail-closed）/ sensitive.ts（argv+重定向敏感面）/ suggest.ts（泛化边界）/ profiles.ts |
| plugin.ts | 重写 | 结构化 AskPayload/AskReply 往返、记忆写入三面（grants 桶/grantStore 持久）、审计 exec 随行、escalatable 资格下发 |
| sandbox/trusted.ts | 删除 | 词表概念整体移除（U1）；env.ts 按 req.exec 分路（direct 免包裹/contained 包裹/缺席 fail-safe） |
| sandbox/fence.ts | 微修 | FenceBase 删 trustedCommands；Fence 增 isolated（U17 override 恒包裹） |
| — | 新建 | fence-suspect.ts（fenceSuspectOf 归因单点——U14） |
| tools dispatch/类型 | 扩展 | PreExecuteDecision 携 exec/escalatable（gateDecision 白名单校验）；ToolExecContext 同字段服务端透传 |
| exec-env SpawnRequest | 扩展 | exec 指令字段 |
| tool-bash | 扩展 | 指令透传 + on-failure 升级流（escalate 桥 plugin 层注入 + 命令文本哈希配额） |
| tool-grep | 微修 | rg spawn 透传 exec |
| harness fenceKit | 重写 | profile/rules/projectRules/protectedPaths/customProfiles 签名；删 trustedCommands |
| host-hub settings-store | 扩展 | permission.rules（RuleEntry[]）/permission.profiles（自定义档）+ 单点校验 + 并集合并（同键项目胜） |
| host-hub 装配/线程 | 接线 | settings 规则两作用域进装配；grantStore 持久面插件；confirm 桥结构化；["bw"] 删除 |
| host-hub worker 命令 | 扩展 | permission/grant + list_rules + remove_rule（P2 管理面） |
| dialogs | 扩展 | ConfirmFields 记忆梯度/建议/escalate 语境；应答结构化（布尔退化=once） |
| CLI | 接线 | --permission 五档；缺省 sandboxed-auto（U6）；--rules flag（P2） |

## 2. 行为变更矩阵（相对旧实现——申报核销面）

| 变更 | 依据 |
| --- | --- |
| auto 档（无围栏宿主）：静态安全命令零交互直通（旧：无 fence 恒 ask） | U4/U5 分类器 |
| sandboxed-auto：未分类/opaque 围栏代问（旧：opaque 恒 ask） | U7 on-failure |
| argv 敏感面（cat ~/.ssh 等）：内核静默拦 → 强制 ask（精确可记忆） | U12 补偿 |
| resolvedBy 词汇：auto:fence/in-fence → classifier:* / grant:* / ask-rule:* | 矩阵词汇 |
| ["bw"]/trustedCommands 免包裹 → exec=direct 指令分路 | U1/U15 |
| ask 单按钮 → 四档记忆 + 泛化建议 | U3/U8 |
| 硬底线/full/plan 口径 | 零变更（U10/U11 钉死；测试原断言保持） |

## 3. 测试口径

- 新增：permission-v2.test（执行矩阵/九不变式/记忆三面/审计 exec/escalatable）、
  classifier.test（fail-closed 对抗：find -delete/dd/rm/tar 不入只读）、suggest.test
  （泛化边界）、sensitive.test（argv+重定向敏感面）、profiles.test（表封闭/保留名）、
  sandbox exec-directive.test（isolated/unfenced/fenceSuspectOf）、tool-bash
  escalation.test（升级流全形态+配额）、host-hub permission-v2-settings.test
  （键校验/合并/坏文件降级）。
- 迁移：旧 mode 三档断言 → profile 五档；in-fence/auto:fence 语义 → classifier 语义
  （见 §2 矩阵）；词表封闭 61→64 命令；host-hub/CLI 值域四副本同步。
- 每条申报变更都有对应红→绿断言锚（permission-flag 旅程、adjudicate 钉表、
  bash-loosening reason 快照）。

## 4. 挂账

无（U9 零挂账）。企业策略层维持问题域外（DESIGN §7）。
