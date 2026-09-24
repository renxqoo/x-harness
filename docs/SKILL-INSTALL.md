# SKILL-INSTALL：技能导入命令面（docs/SKILL-INSTALL.md）

> 状态：定稿（2026-09-23）
> 级别：中（模板 B：方案 + 实施两节）：跨模块（packages/md-frontmatter + packages/skill +
> apps/host-hub）+ 新外部契约（命令面 +2、问题码封闭词表）+ 存量缺陷修复（removeSkill）
> 上游：docs/SKILL.md（@x-harness/skill 内核方案——本件按 §6 裁决 1 改判其 §2「安装 = 手工放
> 目录即安装」）；apps/host-hub/docs/DESIGN.md §3.9（管理面所在节，命令表/结果表同步）
> 消费方：Pai（agent-app）设置面「技能导入」——把本机既存技能目录（`~/.agents/skills`、
> `~/.pi/agent/skills`、`~/.claude/skills`，或用户手选目录）装进用户技能根 `~/.x-harness/skills`

## 0. 目标与边界

**目标**：交付一条**原子、可复核、零规则复制**的用户级技能安装通路，并修好既有移除通路的
存量缺陷。

- 内核（`@x-harness/skill`）**仍然没有安装面**：装载器只判定形态，不写盘。安装/移除属
  **host 管理面**（`skills/*` 命令族，与 `agents/create|remove`、`models/add|remove` 同层）。
- 形态判定（「这个目录是不是一个可装载的技能」）在本件抽出为内核**单点实现**
  （`inspectSkillDir`）：装载器、命令面、写后复检三处共用，**没有任何规则复制**。
- 调用方（Pai 主进程）只传绝对路径；**候选发现、源根白名单、预览编排、文案本地化**全部留在
  宿主侧（渲染层不可信边界在宿主，不在 hub——见 §3 威胁模型）。

**边界（落档）**：

- 「导入」的用户可见语义 = 把选定技能目录**复制**进用户技能根（`~/.x-harness/skills/<name>`），
  源目录不动（不移动、不删除），导入后 Pai 设置面立即可见（`skills/list` 现扫）。
- 模型侧技能清单是**装配期快照**（docs/SKILL.md §2 裁决 3「无热重载」）：导入对**已装配的
  worker 进程**不生效，在该 worker 退出/新装配后生效。本件不改这条内核裁决，改判的是「安装
  通路不存在」，不是「装载时机」。

## 1. 契约

### 1.1 内核形态判定面（新增）

```ts
// packages/md-frontmatter（纯函数包——frontmatter 格式事实的最底层）
export function replaceFlatField(text: string, key: string, value: string): string | undefined;

// packages/skill（装载器与命令面共用形态判定）
export type SkillProblem =
  | "not_found"            // SKILL.md 缺席或父路径非目录（ENOENT/ENOTDIR）
  | "unreadable"           // 其余 IO 失败（EACCES/EIO…）
  | "not_regular_file"     // SKILL.md 非普通文件
  | "too_large"            // 超 1MB（stat 与读后字节双检）
  | "no_frontmatter"       // 无 `---\n` … `\n---\n` 包夹
  | "frontmatter_not_flat" // 无冒号或空键行（md-frontmatter parseFlat 整体拒）
  | "missing_fields";      // 缺 name 或 description

export type SkillInspection =
  | ({ readonly ok: true } & SkillMeta)
  | { readonly ok: false; readonly problem: SkillProblem; readonly message: string };

/** 单目录形态判定：只做解析，不含「name 必须等于目录名」的对齐规则 */
export async function inspectSkillDir(dir: string): Promise<SkillInspection>;

/** 装载器目录名对齐规则（docs/SKILL.md §1.1）：不齐返回告警文案，齐返回 undefined */
export function skillNameMismatch(dir: string, name: string): string | undefined;
```

- `SkillProblem` 是**对外封闭词表**（wire 上出现，宿主按码本地化文案）；`message` 是运维面英文
  细节（与装载器告警文案逐字同源），**不进 wire**。
- `replaceFlatField(text, key, value)`：在 frontmatter 头内替换该键**最后一次**出现的行
  （与 `parseFlat` 的 last-wins 同义），头体其余字节不动；未找到该键、或 text 无 frontmatter、
  或 value 含 `\n`/`\r` → `undefined`（不猜、不重建头）。
- 装载器 `loadSkills` 改为调用 `inspectSkillDir` + `skillNameMismatch`；**既有告警文案逐字不变**
  （`skills: unreadable <file> (ENOENT)`、`skills: <file> name 'x' must match directory name 'y'`
  等——这是等价重构，不是行为变更）。

### 1.2 `skills/inspect`（host 本地）

入参：`{sourcePaths: string[]}`（**非空、≤ 200 条**、每条非空绝对路径）。

结果 `data`：

```ts
{ results: Array<
    | { sourcePath: string; state: "ready";    name: string; description: string }
    | { sourcePath: string; state: "rename";   name: string; description: string }
    | { sourcePath: string; state: "blocked";  problem: SkillProblem }
  > }
```

- 结果**按入参序**（宿主按下标对回自己的候选行）；`sourcePath` 原样回显（不归一化——宿主用它
  定位候选与做源根过滤）。
- `ready`：目录含 SKILL.md 且声明 `name` == 目录名（按 `sourcePath` 的 basename 判，与装载器
  跟随 symlink 目录时「技能名 = 链接名」的既有语义同源）→ 可直接安装。
- `rename`：可解析、`name` ≠ 目录名 → **不是失败**：可安装，目标名 = 声明名（装载器硬要求
  name == 目录名，安装时按声明名落目录即可满足）。
- `blocked`：其余拒因 → 问题码（`SkillProblem` 全集）。
- 只读：不写盘、不改任何状态、无定时器。

### 1.3 `skills/install`（host 本地）

入参：`{sourcePath: string; name?: string; overwrite?: boolean}`。

结果 `data`：`{name: string; path: string; skippedEntries: number}`

- `name` = 最终技能名（= 目标目录名 = 副本 SKILL.md 的 `name`）；
- `path` = 副本 `SKILL.md` 绝对路径（**与 `skills/list` 的 path 同形态**——一处事实一套形状）；
- `skippedEntries` = 未复制的条目数（symlink 与 fifo/socket/device 等奇异条目——见 §3）。

`name` 缺省 = 源目录声明的 name；显式传入时**改写副本**（不是源）的 `name` 行
（`replaceFlatField`），使副本自洽。`overwrite` 垃圾形状（非 true/false）**降级为 false**
（不覆盖是安全侧；真冲突会以 `name_conflict` 明报）。

执行序列（单命令原子效果）：

1. 入参词法校验（绝对路径、name 围栏）；
2. 源形态判定（`inspectSkillDir`）→ 不合格即拒；
3. 目标名 = `name ?? 声明名`；`realpath(源) == realpath(目标)` → 拒（自装自）；
4. 目标已存在且未 `overwrite` → `name_conflict`（不静默覆盖）；
5. 暂存根闸：`~/.x-harness/.tmp` 若已被占为 symlink/普通文件 → 拒（暂存写向技能根外）；
   拷贝源树 → `.tmp/skill-import-<uuid>`（**技能根外**，半成品对装载器永不可见）；
   拷贝中同步统计字节/条目数，超限额即中止；
6. 需要时改写临时副本的 `name` 行；
7. **写后复检（就位前）**：`inspectSkillDir(暂存树)` + `skillNameMismatch(目标路径, 声明名)`
   —— 被换入的字节即被复检的字节（与 `agents/create` 的 round-trip 复析同法；复检不过即
   清暂存并拒，不合格副本永不落进技能根）；
8. `overwrite` 且目标存在：`rename(目标 → .tmp/skill-import-old-<uuid>)` 备份；
9. `rename(暂存树 → 目标)`（同卷原子就位）；
10. 成功：删备份，回 `data`；任一步失败：**回滚**（把备份 rename 回目标、删暂存树）后回错误
    —— 失败路径不改变既有技能（旧内容原地不动）。

### 1.4 错误形态（沿用 `HUB_ERROR_CODES`，无新增码）

| 情形 | code | message（英文中性） |
| --- | --- | --- |
| `sourcePaths` 非数组/空/超 200/元素非绝对路径 | `invalid_input` | `invalid sourcePaths: absolute paths required` |
| `sourcePath` 非绝对路径/含 NUL 换行 | `invalid_input` | `invalid skill source: <raw>` |
| 源不构成可装载技能 | `invalid_input` | `invalid skill source: <problem>: <path>` |
| `name` 越围栏（空/`.`/`..`/含 `/` `\`/控制字符/超 128） | `invalid_input` | `invalid skill name: <raw>` |
| 源与目标同一目录 | `invalid_input` | `skill source is already the install target: <path>` |
| 目录超限额（字节/条目） | `invalid_input` | `skill source too large: <n> bytes`（`too many entries: <n>`） |
| 目标已存在且未 overwrite | `name_conflict` | `skill already installed: <name> (pass overwrite: true to replace)` |
| 用户技能根不在生效技能目录集 | `state_conflict` | `skills root <root> is not an effective skill directory (X_HARNESS_SKILLS_DIRS overrides it)` |
| 拷贝/改名/rename IO 失败（已回滚） | `io_failed` | 原始 errno 文本 |
| 写后复检不合格（已回滚） | `internal` | `installed skill failed loader validation: <problem>` |

`internal` 的辩护：入参合法、形态判定也过了，复检不过说明**执行路径**（拷贝/改写/就位）有缺
陷，不伪装成 `invalid_input`（那是把库的缺陷算到用户输入头上）。

### 1.5 副作用与时序

- 两个命令都是**请求-应答一次性**：回 `data` 时效果已生效（无在飞状态、无事件流、无轮询面）。
- 命令面**不触碰**任何会话/线程状态，不需要 `threadId`、不需要信任门禁（只写用户级，
  与 `skills/remove` 同为无 cwd 命令）。
- **不隐式改 `skills.disabled` 名单**：安装与启用是两个事实（命令单一职责）。宿主导入后
  显式调 `skills/set_enabled{enabled:true}` 恢复启用（旧同名条目被禁用时，导入 = 想用）。

## 2. 问题域

**处理**：

- 判定：单目录 → 三态 + 问题码（`inspectSkillDir`，装载器同源）；
- 安装：拷贝 → 可选改名 → 原子就位 → 装载器复检 → 失败回滚（`installSkill`）；
- 移除修正：`skills/remove` 删**技能目录**而非只删 SKILL.md（存量缺陷 D-1，见 §5 步骤 4）；
- 同路径顺带修复的存量缺陷 D-2：`skills/set_enabled` 带 cwd 时不建 `<cwd>/.x-harness` 目录
  （只有 `settings/set` 建）→ 全新项目上 ENOENT（同一提交 + 症状命名回归用例）。

**不处理（逐项归属）**：

| 不处理 | 归属 |
| --- | --- |
| 候选源根发现/扫描、源根批准白名单、预览编排、文案本地化 | 宿主 app（渲染层不可信边界在宿主主进程） |
| 项目级安装（`<cwd>/.x-harness/skills`） | 无归属：项目资源随仓库走，手工放置（与 `skills/remove` 只删 user 级同一立场） |
| zip/tar/git/npm/marketplace 安装 | 挂账（独立话题：需要归档解包 + 供应链信任面，不在本件） |
| 技能内容编辑/校验（正文、捆绑脚本可信度） | 无归属：统一治理立场（docs/SKILL.md §2——与「恶意 repo 里任何被读文件」同类风险） |
| 已装技能改名（改目录名 + frontmatter） | 无归属：本件的 `name` 只作用于**新拷贝**，不改源、不改已装技能 |
| 热重载 / 装配中 worker 的清单刷新 | 内核裁决 3（一次性装载）保持；导入对已装配 worker 不生效（§0 边界） |
| 权限面（技能目录读写的 PathGate/授权） | `packages/permission` 统辖（既有语义，本件零权限改动） |

## 3. 并发/一致性/安全预算

**量级与资源**（硬约束，常量住 `apps/host-hub/src/shared/limits.ts`）：

- `SKILL_INSPECT_MAX_PATHS = 200`：`skills/inspect` 单批上限，超出即 `invalid_input`；
  单路径成本 = 1×stat + 1×readFile（≤1MB，装载器同限）——单批内存上界 ≈ 200MB 仅在最坏
  全 1MB 时触及，实际技能 SKILL.md 为 KB 级。
- `SKILL_IMPORT_MAX_BYTES = 64MB` / `SKILL_IMPORT_MAX_ENTRIES = 4096`：拷贝期累计统计，超限
  中止并回滚（防「把 5GB 数据集当技能包拷进技能根」）。
- 零定时器、零后台任务、零插件状态；拷贝单遍 IO（readdir + copyFile；技能资产为 KB~MB 量级，
  不做流式分片）。

**一致性**：

- 就位用**同卷 rename**（技术前提：临时树与备份树都在 `~/.x-harness/.tmp`，与技能根同父卷），
  因此「半成品可见」窗口不存在（技能根内要么旧内容、要么新内容）。
- 覆盖 = **备份 + 换入 + 失败回滚**（非先删后拷）：崩溃窗口最坏是「技能暂时不可见」，旧内容
  仍在 `.tmp/skill-import-old-*`（**不自动清扫**——清扫等于静默销毁用户旧技能；残留路径写在本文档，
  人工恢复 = rename 回技能根）。
- 就位前复检暂存树（`inspectSkillDir` + `skillNameMismatch`）把「写盘成功」升级为
  「交付物可用」：改写/拷贝路径的缺陷在命令内暴露 + 回滚，不留半残技能。

**安全**：

- **目标名围栏**：拒空、`.`、`..`、含 `/`、`\`、NUL、换行/控制字符、超 128 → 目标恒为技能根
  下一级目录，`../../` 逃逸不可达。
- **源路径 realpath 归一**后使用（装载器本就跟随 symlink 目录），但**仍要求绝对路径**（相对路径
  属调用方缺陷，整命令拒）。
- **symlink 与奇异条目不复制、不跟随**（计数回显 `skippedEntries`）：否则一个含
  `id_rsa -> ~/.ssh/id_rsa` 链接的技能包可把技能根外的文件引入技能目录供模型读取。
- **威胁模型与归属**：hub 命令面只经 stdio 被宿主主进程触达（无监听面），因此**不做源根白名单**
  ——白名单的守门人是宿主渲染层边界。即使被越权调用，命令面能做的仅是「把本机已存在、且形态
  为合法技能的目录复制进用户技能根」：不读回内容、不越出技能根、不解析也不执行技能内容。
- **暂存根闸**：`.tmp` 必须是本命令自己控制下的真实目录（symlink/文件占位即拒）——否则暂存在
  链接目标里创建、失败回收也会打到别人目录里。
- **`skills/remove` 删除围栏**（D-1 修复的一部分）：删前断言目标是技能根**直接子项**，否则拒
  （防未来重构把 `rm -rf` 指向根外）；symlink 技能只删链接不删目标（node `rm({recursive:true})`
  对 symlink 根不跟随——用例钉死）。

## 4. 拆分

| 位置 | 内容 |
| --- | --- |
| `packages/md-frontmatter/src/replace.ts`（新） | `replaceFlatField`（唯一新动词，纯函数） |
| `packages/skill/src/inspect.ts`（新） | `inspectSkillDir` + `skillNameMismatch` + `SkillProblem`/`SkillInspection` 类型 |
| `packages/skill/src/loader.ts`（改） | 改调 inspect（等价重构，告警文案逐字不变） |
| `packages/skill/src/types.ts`（改） | 导出面补类型（index.ts 同步） |
| `apps/host-hub/src/shared/skills-paths.ts`（新） | `userSkillsDirOf(homeDir?)` / `projectSkillsDirOf(cwd)`——目录约定单点（现散在 skills-admin 与 worker/assembly 两处，第三处即将出现） |
| `apps/host-hub/src/host/skills-install.ts`（新） | `inspectSkillSources` / `installSkill`（拷贝、改名、就位、复检、回滚） |
| `apps/host-hub/src/host/skills-admin.ts`（改） | `homeDir` 注入缝（与 `agents-admin` 同法）+ `removeSkill` 目录删除修复 |
| `apps/host-hub/src/host/admin-commands.ts`（改） | 两命令注册（`deps.homeDir` 透传） |
| `apps/host-hub/src/protocol/commands.ts`（改） | 词表 +2（58 → 60），计数注释同步 |
| `apps/host-hub/src/shared/limits.ts`（改） | 三个导入限额常量 |

依赖方向：`md-frontmatter ← skill ← host-hub`（无反向依赖；hub 不 import 宿主任何东西）。

## 5. 实施顺序（每步独立提交、四门全绿）

1. `md-frontmatter` `replaceFlatField` + 单测（last-wins 替换、无 frontmatter、键缺席、
   value 含换行拒、头体其余字节保真）；
2. `packages/skill` 形态判定抽出（`inspect.ts` + loader 改调）+ 单测（loader 既有 24 用例
   全绿即等价性证据；表驱动补 7 个问题码逐项）；
3. `skills-paths` 单点化（skills-admin / worker/assembly 改引用，零行为变化）；
4. **存量缺陷 D-1/D-2 修复**：`skills-admin` `homeDir` 缝（关闭「user 技能根不可测隔离」）
   + `removeSkill` 删技能目录（直接子项围栏、symlink 只删链接）+ 回归用例（用例名点名症状：
   *残留目录导致每次装载告警*）；`setSkillEnabled` 项目级写入前自建目录 + 回归用例
   （*全新项目上 ENOENT*）；
5. `skills-install`（inspect/install）+ 单测（问题码表、名围栏、冲突、覆盖回滚、symlink 计数、
   限额、自装自、写后复检）；
6. 命令注册 + 词表 + host 命令面黑盒矩阵（`homeDir` 注入隔离——既有「user 目录不可隔离」的
   测试缺口同批关闭）+ 计数锚更新（58 → 60，三处）；
7. 文档同提交：本文件 + `docs/SKILL.md` §2 改判 + `apps/host-hub/docs/DESIGN.md`（§3 命令表、
   §3.9 段、附录 B 结果表）+ 覆盖率数字收口。

过渡态：无（步骤 2 是等价重构，步骤 4 是缺陷修复，步骤 5/6 是纯加法）。

## 6. 裁决

| # | 裁决 | 类型 |
| --- | --- | --- |
| 1 | 安装面落在 hub 命令面（`skills/inspect` + `skills/install`），而非宿主直写技能根、也非 hub 单命令 `skills/install` 独挑 | **用户裁决（2026-09-23，H 路线）** |
| 2 | 候选发现（源根扫描/白名单/预览编排）留在宿主；hub 只按传入绝对路径判定与安装 | 默认裁决（否决窗口） |
| 3 | 形态判定单点 = 内核 `inspectSkillDir`；宿主零规则复制（wire 上给问题码，文案由宿主本地化） | 默认裁决（否决窗口） |
| 4 | `name` ≠ 目录名**不是**问题码：`rename` 是正常态（目标名 = 声明名），装载器对齐规则只影响落目录名 | 默认裁决（否决窗口） |
| 5 | 覆盖 = 备份 + 原子换入 + 回滚（非先删后拷） | 默认裁决（否决窗口） |
| 6 | 拷贝跳过 symlink/奇异条目并计数回显（不跟随、不重建） | 默认裁决（否决窗口） |
| 7 | 安装不隐式改 `skills.disabled`：启用由宿主导入后显式 `skills/set_enabled` 完成 | 默认裁决（否决窗口） |
| 8 | 导入限额硬拒：单批 200 路径 / 64MB / 4096 条目 | 默认裁决（否决窗口） |
| 9 | 用户技能根不在生效目录集（`X_HARNESS_SKILLS_DIRS` 覆盖）→ 拒装并说明（防「装了不可见」静默） | 默认裁决（否决窗口） |
| 10 | 写后复检不合格 → `internal`（不伪装 `invalid_input`） | 默认裁决（否决窗口） |
| 11 | 修 D-1：`skills/remove` 删技能目录（直接子项围栏）；symlink 技能只删链接 | 默认裁决（否决窗口，存量缺陷） |
| 13 | 修 D-2：`set_enabled` 项目级写入前自建 `<cwd>/.x-harness`（本件新用例暴露——与 `settings/set` 对齐） | 默认裁决（否决窗口，存量缺陷） |
| 12 | `skills-admin` 补 `homeDir` 注入缝（与 `agents-admin` 同法）——关闭既有「user 技能目录不可测隔离」缺口 | 默认裁决（否决窗口） |

## 7. 测试口径

**契约级**：

- `SkillProblem` 词表 == 文档 §1.1 逐项（表驱动遍历 7 码，每码一条断言）；
- `skills/inspect` 三态判别联合逐形态；结果序 == 入参序（含重复路径）；
- `skills/install` 成功形态（`{name, path, skippedEntries}`，path == `<root>/<name>/SKILL.md`
  且 `skills/list` 现扫能读到同一 path——**跨命令一致性断言**）。

**边界与异常（表驱动）**：

- 形态矩阵：缺席目录/空目录/无 SKILL.md/SKILL.md 是目录/超 1MB/无 frontmatter/非 flat
  （无冒号行、空键行）/缺 name/缺 description/name ≠ 目录名 → 对应码 + `rename` 态；
- 名围栏矩阵：`""`、`.`、`..`、`a/b`、`a\b`、`a\nb`、含 NUL、129 字符 → 全 `invalid_input`；
- 覆盖：无 `overwrite` → `name_conflict`（**且原目录字节未变**）；带 `overwrite` → 换入成功、
  备份清除、旧 bundled 文件不再存在；`overwrite` 传垃圾值（`"yes"`）→ 降级 false；
- 回滚（全部用 chmod/只读目录构造，确定触发）：嵌套子树内文件不可读 → 整树回滚；
  暂存目录不可建（`.x-harness` 只读）→ 技能根无新内容；覆盖路径备份改名失败（技能根只读）
  → 旧内容原地不动；三条都断言 `.tmp` 无残留、错误码 `io_failed`；
- 限额：超字节 → `invalid_input` + 回滚；超条目数 → 同上；
- 自装自：`sourcePath` == 目标 → `invalid_input`；
- symlink：源树内 symlink 条目 → `skippedEntries` 计数 + 目标内无该链接；源目录本身是 symlink
  → 复制其内容（跟随既有装载器语义）；`.tmp` 被占为 symlink → `io_failed` + 链接目标零写入；
- 生效目录集：`X_HARNESS_SKILLS_DIRS` 指向别处 → `state_conflict`（用例内 set/restore env）。
- **D-1 回归**：技能目录含捆绑文件（`references/x.md`）→ `skills/remove` 后**整个目录消失**
  （症状：旧实现只删 SKILL.md，残留目录对每次装载吐 `unreadable ... SKILL.md` 告警）；
  symlink 技能 → 链接消失、目标目录内容仍在。
- **D-2 回归**：`set_enabled {cwd}` 在**没有** `<cwd>/.x-harness` 的全新项目上落盘成功
  （症状：旧实现 ENOENT 抛穿处理器）；并覆盖「enable 后 user 名单残留 → `stillDisabled: by user`」。

**分层**：

- 单元：`md-frontmatter` replace、`packages/skill` inspect（+ loader 既有用例回归）；
- 命令面黑盒：`host-commands.test.ts` 真 `runHost` + `homeDir` 注入隔离 —— `skills/inspect`
  与 `skills/install` 全链（装完 `skills/list` 见 `source:"user"`、`skills/set_enabled` 可开关、
  `skills/remove` 可删），垃圾入参矩阵；
- 词表锚：`smoke.test.ts` / `contracts-frames.test.ts` 计数 58 → 60；注册表互检
  （`worker-uncovered.test.ts`）自动覆盖新命令名。

**不写**（`docs/SKILL-INSTALL.md` §2 不处理项）：zip/git 安装、项目级安装、装配刷新、
内容编辑——无对应实现，也就无对应用例（不留空转用例）。

## 8. 验收清单

- [ ] §1.1 内核面两条导出 + 类型（含 `SkillProblem` 七码）+ `replaceFlatField` 语义逐条
- [ ] §1.2 / §1.3 两命令入参出参形状、结果序、`path` 与 `skills/list` 同形态
- [ ] §1.4 错误表逐行（code + message 关键片段）
- [ ] §1.5 一次性语义（无在飞/无挂起）、不隐式改 `skills.disabled`
- [ ] §2 不处理清单逐项无实现（无 TODO、无占位）
- [ ] §3 预算逐条：三常量硬拒、同卷 rename、崩溃残留口径、名围栏、symlink 跳过、删除围栏
- [ ] D-1 修复 + 症状命名回归用例（`skills/remove` 目录删除、symlink 只删链接）
- [ ] D-2 修复 + 症状命名回归用例（`set_enabled {cwd}` 全新项目落盘 + `stillDisabled` 语义）
- [ ] `docs/SKILL.md` §2 改判 + DESIGN.md 三处表格同提交
- [ ] 四门全绿 + 覆盖率数字如实报告（行 ≥ 90 / 分支 ≥ 85，只升不降）
- [ ] 对抗审查（独立会话/diff + 本文件节选）问题清零
