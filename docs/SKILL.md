# SKILL 子系统方案（docs/SKILL.md）

> 状态：已核销（收口审查 13 项发现全处置；数字见 §8）
> 级别：中（模板 B：方案 + 实施两节）

skill = 目录里的 SKILL.md 资产（frontmatter 元数据 + 指令正文 + 可选捆绑文件）。
本子系统只做一件事：**让模型知道有什么 skill、在哪**。内容披露、触发、执行全部
复用既有机制，本包零新增执法面。

## §1 契约

### §1.1 文件系统契约

- 一个 skill = skills 根下的**一个子目录**，内含 `SKILL.md`；捆绑文件（脚本/参考
  文档）放同目录子树，由模型经 read 工具按正文引用自行读取。
- `SKILL.md` frontmatter：每行 `key: value`，无冒号或空键的行 → 拒注册该文件；
  值为原样字符串（不做结构解析——内联数组等按字符串收）；必填 `name`、
  `description`；`name` 必须与目录名一致；正文为 frontmatter 之后的全部内容
  （本子系统不消费正文，仅供模型读取）。此语义 = 共享包 `md-frontmatter`
  的实际行为（与 agent-delegation 迁移后单一实现一致）。
- `SKILL.md` 大小上限 1MB（读前 stat）：超限拒注册 + 告警。
- 目录解析：插件参数 `skillsDirs` > 环境变量 `X_HARNESS_SKILLS_DIRS`（冒号分隔，
  空串元素过滤）> 缺省 `[<cwd>/.x-harness/skills, ~/.x-harness/skills]`。
  **`skillsDirs: []` = 显式零**（不扫描、不注入）。注意：与姊妹实现
  `resolveAgentDirs` 的 `[]` 落空回退 env 行为**有意不同**（显式零供嵌入方/测试
  表达关闭——差异在此钉死，防照抄）。列表序即优先序：同名 skill 前者胜（项目域
  覆盖用户域）。目录按原样使用（缺省两条为绝对路径）。
- 目录缺席合法（未配置任何 skill）；skills 根**存在但不可读**（EACCES 等，非缺席）
  → 告警不静默；垃圾输入（SKILL.md 不可读/超限/非普通文件、无 frontmatter、
  缺字段、无冒号或空键行、name 与目录名不符）拒注册该 skill + onWarn 告警，
  不 throw 不崩。
- symlink 目录跟随加载（stat 解引用——stow/dotfiles 摆放可用；skill 名 = 链接名，
  frontmatter name 须与链接名一致）；断链与普通文件同策静默忽略。

### §1.2 包契约

- `@x-harness/md-frontmatter`（新，纯函数包，最底层）：
  `splitFrontmatter(text) → { head, body } | undefined`；
  `parseFlat(head) → Map<string, string> | undefined`；
  `replaceFlatField(text, key, value) → string | undefined`（头内该键最后一次出现的行
  替换——与 parseFlat last-wins 同义；无 frontmatter/键缺席/键值形态非法 → undefined）。
- `@x-harness/skill`（新）：
  - `SkillMeta { name; description; path }`——path 为 SKILL.md 绝对路径；
  - `resolveSkillDirs(configured?) → readonly string[]`；
  - `loadSkills(dirs) → Promise<{ skills: Record<string, SkillMeta>; warnings: string[] }>`；
  - `inspectSkillDir(dir) → Promise<{ ok: true; name; description; path } | { ok: false;
    problem: SkillProblem; message }>`——**形态判定单点**（装载器、host 命令面、安装
    写后复检共用；`SkillProblem` = not_found/unreadable/not_regular_file/too_large/
    no_frontmatter/frontmatter_not_flat/missing_fields）；`skillNameMismatch(dir, name)`
    ——目录名对齐规则（本文件的注册条件，不属于解析条件），不齐返回告警文案；
  - `renderSkillsBlock(skills) → string`——空表 → `""`；否则
    `<system-reminder>\n### Available skills\n- name: description (path)\n…\n</system-reminder>`
    （按 name 排序）。渲染防护（三字段同洗）：name/description/path 去换行与
    控制字符、`</system` 字面量中和（`<\\/system`）；description 额外截断 200
    字符；条目上限 50，超出追加 `… and N more` 行；
  - `createSkillPlugin(options?) → Plugin`——name `"skill"`，`inject: ["agent-loop"]`。

### §1.3 注入契约（时序与幂等）

- **装载**：插件 apply 内 `await loadSkills(dirs)` 一次性扫描（loadPlugins 语义：
  apply 完成即快照可用）；此后进程内不再读盘、不刷新（快照进程常量）。
- **注入（无状态幂等）**：快照非空时经 `createTailSnapshot` 共用原语
  （@x-harness/agent-loop，docs/TAIL-SNAPSHOT-CHANNEL.md）注册 running 边沿监听：
  render（进程常量块）→ 在场判定（仅扫 append 型 user/message 单 text 块的全文
  精确匹配——replace 型摘要节点不扫）→ 缺席同步追加
  `session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: 块 }] }, { surfaceOp: "append" })`，
  在场跳过。**无插件状态**（无 Set/Map）：幂等性由在场判定自身保证。
- **同步红线**：监听器整体同步（emit 链同步分发，kick 头 running → 监听器 →
  append 全部发生于 `deriveMessages()` 求值之前）——引入任何 await 即失效，
  测试以「注入块事件 seq < 当轮 turn/start seq」锁死。
- **零快照**：完全无痕——不注册监听、不追加任何事件。
- 时序依据（已核实的既有事实）：`driver.ts` kick 头先 `emitStatus("running")`
  （:102）后 turn 循环；步序 `anchorSystem`（:149）先于 `appendUserBatch`（:150）。
  新会话首轮 surface = `[skill块, system 锚点, user 批次]`——注入先于该 turn 的
  `deriveMessages()`，首轮请求即可见；llm 层 `pi-context.ts` 按 role 提取 system
  （位置无关，两协议工厂共用同一映射，连续 user 形态既有先例）；注入消息 data
  无 `text` 字段，不会被锚点搜索（首个含 text 节点）误判；`isCount` 门接受 0。
- **压缩存活语义**（已推演）：
  - REPL `/compact`（compactionRunner 手动面，`@x-harness/compaction`）：切口
    protectedHead 从锚点之后起算。新会话注入位于锚点前（surface[0]）→ 永久存活；
    resume 场景历史中旧块在锚点后 → 被折叠，下一次 `running` 存在性检查发现缺席
    → 尾部补注入（自愈）。
  - repair（repair.ts:61-75）：trailingClaims 以 user/message 推进 lastUserIndex
    并清积累；注入块先于一切 claim 落账 → 对 claim 恢复惰性。
- **累积语义（如实）**：同进程快照常量 → 文本相等去重使同快照永不重复注入
  （fork 子代理继承父 surface 中的相同块 → 不再注入，无双份；跨进程 resume
  快照未变 → 零追加）。**跨进程快照变化时**：每次变化在尾部追加一个新块，旧块
  仅在压缩（/compact 或未来压缩器）后折叠——压缩周期内在场块数 = 该周期内的
  快照变化次数（当前 CLI 无自动压缩，依赖手动 /compact；无压缩纪律时随进程
  漂移线性增长——已知接受的边界，后果有界：模型读到失效 path 时由工具报错
  自纠）。
- resume 语义：历史中旧快照块保留（冻结）；快照未变 → 不注入（零冗余）；快照
  变化 → 尾部注入新块（刷新）。

### §1.4 错误形态

- loader 全路径降级：拒注册 + warnings 数组（不 throw）；apply 内对 loadSkills
  另有 try/catch 兜底（意外异常 → 空快照 + 告警收场，不阻断装配——结构保证）。
- onWarn 缺省写 stderr（jsonl 持久化 onIoError 同例）——宿主不接告警也不静默。
- 注入 append 失败（防御分支：生产封存路径先摘句柄走 loop.get 缺位）→ onWarn；
  下次 running 存在性检查自然重试（幂等）。

## §2 问题域

- 处理：扫描（一次）、渲染（纯函数，含防护性清洗/中和/截断/上限）、注入（幂等）。
- 不处理（归属落档）：
  - 内容披露 = 模型经 read 工具读 SKILL.md/捆绑文件（permission/PathGate 统辖，
    用户域首读 ask 一次入会话 extraRoots——既有语义，skill 无特权无特防）；
  - 触发 = 模型自主（无专用工具、无 slash 集成，命令闭集不动）；
  - 安装 = 手工放目录（内核零安装面）**或** host 管理面 `skills/install` 拷贝导入
    （docs/SKILL-INSTALL.md——安装面归 host 命令面，内核只判定形态）；
    marketplace/归档包（zip/git/npm）安装 = 独立挂账话题；
  - 热重载 = 不做，增改 skill 下次进程启动生效；
  - skill 层权限策略 = 零（deny-write 收紧提议已撤销，统一治理）；
  - system prompt = 不含任何 skill 字节（进程生命周期内字节稳定——KV cache 前缀
    结构性不失效）。
- 已知接受的边界（落档）：
  - 项目域 skill 的 name/description 会随清单进模型上下文——与「恶意 repo 里
    任何被读文件」同类风险（统一治理立场）；渲染的三字段清洗/中和/截断/条目
    上限把该无门面做成有界。
  - 无压缩装配时跨进程快照漂移的清单块线性累积（见 §1.3 累积语义）。
  - ~~挂账：`packages/compaction` L2 头部守卫会被技能块占 surface[0] 击穿~~
    已核销：保留头改为锚点谓词定位（`session.anchorIndexOf` 共用）+ 切口候选
    以保留头为下界——预锚注入豁免一切切口角色（docs/COMPACTION.md §1.1）。

## §3 并发/一致性预算

- 装配期一次扫描：目录数 × (readdir + stat + readFile ≤1MB) 量级，await 完成即止。
- 运行期零定时器、零 IO、零插件状态：每次 `running` 一次 O(surface 节点数) 的
  浅拷贝与存在性检查（字符串比较，长度不等即短路；当前 CLI 无自动压缩，节点数
  随会话线性增长——10^5 节点量级单次 ~ms 级，远低于一次 LLM 调用）；命中缺席时
  一次同步 `session.append`（纯事件落账）。

## §4 拆分

- 新包 `packages/md-frontmatter`（无依赖，被 skill 与 agent-delegation 依赖）；
- 新包 `packages/skill`（依赖 md-frontmatter、agent-loop、core）；
- 迁移：`agent-delegation/src/types-loader.ts` 删除本地 splitFrontmatter/parseFlat，
  改 import `@x-harness/md-frontmatter`（同提交，单一实现，行为不变）；
- 装配：`apps/cli/src/build-world.ts` 数组加 `createSkillPlugin()`；
- 文档：docs/CLI.md §1 裁决行改判 + §2.5 装配清单更新；本文件。

## §5 实施顺序（每步独立提交、四门全绿）

1. `packages/md-frontmatter` + agent-delegation 迁移 + 两侧测试；
2. `packages/skill`（loader/render/plugin）+ 测试；
3. CLI 装配 + docs（CLI.md 裁决行、§2.5 清单、插件数注释同步）。

无过渡态（纯加法 + 等价重构，收口即单轨）。

## §6 裁决

| # | 裁决 | 类型 |
| --- | --- | --- |
| 1 | 无专用 skill 工具，披露走 read 通道 | 用户裁决 |
| 2 | skill 层零权限策略，permission 统辖 | 用户裁决 |
| 3 | 无热重载，一次性装载（快照进程常量） | 用户裁决 |
| 4 | 清单为独立 user/message 注入，system prompt 保持零 skill 字节 | 用户裁决 |
| 5 | frontmatter 抽共享包并同提交迁移 agent-delegation | 默认裁决（否决窗口） |
| 6 | 装配期扫描视同「首次对话加载」（差异仅进程启动后、首轮对话前新增的 skill） | 默认裁决（否决窗口） |
| 7 | 子代理会话同样注入；fork 继承的相同块经幂等检查自然去重 | 默认裁决（否决窗口） |
| 8 | 零快照完全无痕（不注册监听） | 默认裁决（否决窗口） |
| 9 | 无状态幂等注入（存在性检查替代去重 Set）——处置审查 P1/P2/P4 | 默认裁决（否决窗口，审查处置） |
| 10 | 渲染防护扩至三字段清洗 + `</system` 中和 + 截断 200 + 条目上限 50 + SKILL.md 1MB 上限——处置审查注入面/体积发现 | 默认裁决（否决窗口，审查处置） |
| 11 | `skillsDirs: []` = 显式零，与 resolveAgentDirs 有意不同（文档钉死） | 默认裁决（否决窗口，审查处置） |
| 12 | 累积上界条件化（压缩周期内），无压缩漂移累积落档已知边界；compaction L2 守卫击穿挂账 | 默认裁决（否决窗口，审查处置） |
| 13 | symlink 目录跟随加载（skill 名 = 链接名）；根不可读（非缺席）告警——处置收口审查 F1/F4 | 默认裁决（否决窗口，审查处置） |
| 14 | onWarn 缺省写 stderr + apply 兜底空快照（结构保证）——处置收口审查 P1-1/P3-2 | 默认裁决（否决窗口，审查处置） |
| 15 | 渲染防护收口：截断按码点（代理对不截半）、中和大小写不敏感含开标签、清洗扩 Cf 类——处置收口审查 F3/F5 | 默认裁决（否决窗口，审查处置） |

备注（落档）：裁决 4 的原始动机（动态数据防 system prompt 前缀抖动）随裁决 3
（不重载）已消解——静态快照入 system prompt 亦无 cache 成本。放置维持 user
消息的理由更新为：转录可审计（模型当时看到什么，回放里就有什么）+ system
prompt 结构性静态作为防线保留（未来任何动态化倾向都会先撞上这道墙）。

## §7 测试口径

- 契约级：render 输出逐字节断言（空/排序/格式/三字段清洗/`</system` 中和/
  截断两侧/上限溢出行）；注入幂等（同会话多次 running 仅一块；块在场时零追加）；
  注入后 deriveMessages 首位含块；**同步红线：注入块事件 seq < 当轮 turn/start
  seq**；零快照零监听零事件；存在性检查扫 `type === "text"` 块（空 content /
  首块 tool_use 的 user/message 不误判）。
- 边界（表驱动）：无目录/空目录/非目录项忽略/**断链忽略**/**symlink 目录跟随**/
  **根 EACCES 告警**/**SKILL.md EACCES**/**SKILL.md 为目录**/超 1MB 拒/无
  frontmatter/无冒号**与空键**行拒/缺 name/缺 description/name 与目录名不符/
  同名优先级覆盖/`[]` 显式零/env 空串过滤/**env 仅冒号 → 显式零**/
  参数>env>缺省矩阵/200 码点截断两侧/**代理对不截半**/控制字符（含中位 \r、
  ESC）清洗/**Cf（ZWSP/RTL）清洗**/**中和大小写与开标签**/>50 条溢出行
  （**幸存者身份钉死**）。
- 压缩交互：折叠尾块 → 下次 running 补注入；**头块（锚点前）经折叠在场且
  不重注入**。
- 回归：append 失败（封存会话）告警不崩、下次幂等重试；dispose 后监听器摘除。
- 既有回归：agent-delegation types-loader 全量用例迁移后全绿。

## §8 验收清单

- [x] §1.1–§1.4 契约逐条（两轮方案审查 + 收口契约对照核实为真）
- [x] §7 边界表逐项（skill 51 用例：loader 24 / render 9 / present 4 / plugin 14）
- [x] §3 预算逐条（零定时器/零运行期 IO/零插件状态；O(surface) 存在性检查）
- [x] 四门 + 覆盖率数字：typecheck/lint(0-0)/build 绿；全量 test 1684/1687
      （3 败归属他人在途 apps/cli/src/cli-prompt-sections.ts 变更）；包覆盖
      skill 98.11/94.36/100/98.79、md-frontmatter 100/100/100/100；
      e2e 13 场景全通过
- [x] docs/CLI.md 裁决行与装配清单同提交更新

假绿抽查记录：skip 仅 2 处 `skipIf(getuid() === 0)`（root 下 chmod 不产生
EACCES 的平台条件，非门禁规避）；收口批次断言只加强未削弱（幸存者身份钉死、
封存重复边沿、头块压缩在场）。

挂账（不越界代修）：① ~~compaction L2 头部守卫~~ 已核销（锚点谓词保留头 +
protectedHead，见 §2）；② `packages/llm pi-wire.test.ts` "Retry-After
HTTP-date" 并行调度偶发——已修（未来日期用例体内现算，表构造期求值被调度
延迟吃掉断言窗口是根因）。
