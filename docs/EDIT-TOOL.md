# edit 工具（精确文本替换）方案

> 状态：草稿（中级——新工具插件 + 外部契约新增 + 观察门交互）
> 参考实现：/Users/wrr/work/pi/packages/coding-agent/src/core/tools/edit.ts + edit-diff.ts + file-mutation-queue.ts（结构借鉴；实现按 x-harness 架构重写——判别联合/授权面/观察门 CAS/插件装配）
> 关联：docs/TOOLBOX.md（工具面）、docs/TRUNCATED-TOOL-RESCUE.md 层 2（edit 抢救已在 v1 表内——`new_string` 提取器就位，本工具落地后自然接入）、packages/tool-write（授权/门/CAS 同构参照）

## 需求

模型当前修改文件只能 write 全量重写（或 bash sed——系统提示明劝不要用）。大文件小改动的场景（改一个函数、重命名一个变量）token 成本是全文重写，且截断风险随文件大小线性涨——**edit 工具正是 TRUNCATED-TOOL-RESCUE 事故画像的对症工具**（事故源头就是大 write）。

## 分级裁决

中级：新工具 + 模型可见契约（schema/prompt 指引）+ 观察门 CAS 交互（读后改语义）+ 文件互斥并发面。

## 契约（对模型）

```
edit(path, edits: [{oldText, newText}, ...])
```

- `edits[]` 全部对**原始文件**匹配（非增量应用）；`oldText` 必须**唯一**（多处出现报错要求加长上下文）；条目间不得**重叠**（重叠报错要求合并）。
- 精确匹配优先；失败时**模糊匹配**兜底：NFKC 归一 + 行尾空白剥离 + 智能引号/破折号/特殊空格归一 ASCII（pi 同源规则——模型对 Unicode 细节的典型失误面）。模糊命中时未触动的行保持原始字节（归一只发生在被触碰的行块）。
- 行尾风格保真（CRLF 文件改完还是 CRLF）；BOM round-trip（write 同款）。
- 结果回显：成功条数 + **统一 diff**（模型可见改了什么——多 edit 场景的自我校验面）。

## 实施形态（x-harness 架构对齐）

**新包 packages/tool-edit**（TOOLBOX.md §0「一命令一包」——第 5 个命令 = 新包 + createToolPlugin，内核与其余命令包零改动；非「一动词一文件」——那是文件内组织纪律非包边界判据，对抗审查 C 件 2 修正）：

| 文件 | 职责 |
|---|---|
| `edit.ts` | 工具本体：schema + 执行管线（门→互斥→读→BOM/行尾→匹配应用→写→登记→回显） |
| `edit-apply.ts` | 纯函数域：精确/模糊匹配、多 edit 校验（唯一/重叠/空 oldText/无变化）、行尾保真应用——pi edit-diff.ts 的移植面（去 diff 生成——见下） |
| `plugin.ts` | createEditPlugin：createToolPlugin 装配（gate/observed/env 三件套与 write 同源） |

**与 pi 的关键差异（按 x-harness 既有裁决重写，非照抄）**：

1. **授权/门/CAS 全套**：pi 的 edit 只有 cwd resolve——无 PathGate/无观察门。x-harness 版走 write 同款完整管线：`admitSession`（越根/穿越拒）→ `observed.locked(path)`（同路径互斥——**取代 pi 的 file-mutation-queue 模块级 Map**：x-harness 已有进程内互斥原语，observed.locked 就是干这个的，且键含会话语义）→ **FS_NOT_OBSERVED/FS_STALE_VERSION 门**（编辑前必须本会话读过且未变——与 write 覆盖同门；edit 语义天然是「改刚看过的东西」，门语义比 write 更贴）→ `env.writeFileAtomic`（原子写）→ `observed.record` 写后登记（edit→write 连续操作不被自己的门拒）。
2. **diff 生成**：引 npm `diff` 依赖（pi 同款 8.x——`diffLines` + `createTwoFilesPatch`）。裁决（用户拍板）：不自写 LCS——边界坑（末行无换行/行内多改动块分割/hunk 合并）三方包已踩平，自写的隐性成本高于一行依赖；pi 同版本号背书。
3. **错误回显**：pi 用 throw + 全局包装；x-harness 用判别联合 `{content, isError}`（AGENTS.md 风格门）。错误文案带可行动指引（NOT_FOUND 提示精确含空白、DUPLICATE 提示加长上下文、OVERLAP 提示合并——pi 文案风格保留）。
4. **abort 语义**：pi 的 throwIfAborted 逐 await 检查；x-harness 工具执行面已有 signal 约定（ToolExecContext）——对齐即可，互斥释放走 observed.locked 的 finally（与 write 同构）。
5. **inputSchema 用 TypeBox**（pi 也是 typebox——直接同构）；pi 的 prepareArguments 模型容错**不移植（对抗审查 C 件 3 修正论据——这是事实题非哲学题）**：pi 容错面向 Opus 4.6/GLM-5.1 的 edits-as-string 方言；x-harness 当前模型面 glm-5.3 无实证此形态——论据落「当前模型面无此形态」而非「不为单模型开旁门」。dial 面（providers.json 任意 anthropic 兼容端点）接入有此方言的模型时，届时按需最小移植 15 行（string→parse、单对象→数组两形，不含 legacy 顶层字段）并记档为方言容错。

**harness 装配**：`toolboxKit` +1 行（`createEditPlugin({ gate, observed, ...env })`——三件套与 read/write 同源实例，漏配症状 FS_NOT_OBSERVED fail-closed 同 write 注释口径）。

**rescue-plugin 归属记档（对抗审查 C 件 2）**：createTruncatedWriteRescuePlugin 住 tool-write 包但覆盖 write+edit 两工具（TRUNCATED-TOOL-RESCUE 定稿时 edit 尚不存在）——**维持不动**：迁移包的 churn 大于命名收益，edit 的提取器升级在原文件内以独立函数追加（extractLastEditText），插件名与归属待第三工具入抢救表时一并重命名（那时才有结构压力）。

**TRUNCATED-TOOL-RESCUE 接入**：零改动——rescue-plugin 的 `name.includes("edit")` 分支已在 v1 落地（`new_string` 提取）；edit 工具参数里最大的字符串就是 newText，截断抢救自然生效。方案文档批 2 节的抢救表已在等这个工具。

**系统提示（对抗审查 C 件 4——落点重写）**：用法守则走 `createToolPlugin({ guidance })` 停靠 system-prompt 的 `tool/edit` 段（tool-core tool-plugin.ts:34-47 投稿机制——pi promptGuidelines 4 条的 x-harness 等价物，tool-bash bashGuidance 先例）：唯一性/不重叠合并/最小上下文/对原文匹配非增量。description 只留工具自述；write 的 description 补分流句（for targeted changes prefer edit）。base-prompt.ts:79 已预埋 edit 一词（"Prefer dedicated tools (file read, edit, write)"）——本工具落地使该预埋成为真实承诺，无需改基础段。

## 测试口径（对抗审查 C 件 5——按 pi 全集 ~40 例起列）

- **edit-apply 纯函数**：精确命中/多处命中拒/未命中拒/重叠拒/空 oldText 拒/无变化拒；**部分失败不部分落盘**（任一 edit 失败全批拒——原子性断言）；多 edit 逆序应用偏移稳定。
- **模糊匹配（13 例规模——pi 踩坑面全集）**：五归一各形（中文引号/智能引号/破折号/NBSP/NFKC/行尾空白）；**精确优先于模糊**（文件同时存在精确命中与可模糊命中处——走精确）；**归一后重复检测**（原文两处经归一变相同 → DUPLICATE 独立触发面）；**模糊替换后与邻行同文的保真**（fuzzy-preserve-duplicate-line——pi 真坑，错则换错位置）；模糊命中未触行字节保真；多 edit 混合精确/模糊。
- **CRLF/BOM（7 例规模）**：LF oldText 对 CRLF 文件；**跨行尾形态的重复检测**（CRLF 处与 LF 处归一后同文）；CRLF/LF 混合文件多 edit；BOM+CRLF 叠加；BOM round-trip。
- **edit 工具**：门三态（未读拒/读后改过拒/读后未变过——bash 改后 STALE 链）；越根/穿越拒；目录/非常规文件拒；成功回显含 diff；写后登记（edit→write 连续不拒）。
- **diff 组装**（三方包背书算法——只测组装面）：上下文 4 行窗口/firstChangedLine 提取/空文件边界。
- **装配**：toolboxKit 含 edit；三件套同源（read→edit→write 链路）；guidance 停靠 `tool/edit` 段断言。
- **回归**：write 既有用例不破；rescue-plugin edit 分支用**真 edit 名 + 真 schema 参数形态**（`{"path":..,"edits":[{"oldText":..,"newText":"半截`）——末条 newText 提取 + note 新文案。

## 不处理（归属）

- replace_all/正则形态——oldText 唯一性约束下不需要（真需要时模型自己多 edit 或 write）；
- 多文件原子编辑——跨文件事务是 write/edit 都没有的语义，单独议题；
- pi 的 EditOperations 注入面（SSH 远程编辑委托）——x-harness 的 ExecEnv 就是那个抽象，已有。

## 实施批次

1. edit-apply 纯函数 + 用例（无依赖先行）。
2. diff 生成 + 用例。
3. edit 工具 + plugin + 装配 + 用例（含观察门全链）。
4. 系统 description 调整 + rescue 真名回归 + 四门 + 对抗审查。
