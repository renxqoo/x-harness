# GIT 交互重构方案（借鉴 ZCode 优点 · 删自实现劣势 · 人机交互优先）

> 状态：草稿（待对抗审查）
> 级别：中级（跨 x-harness / agent-app 两仓；UI 交互重构为主，协议加两个只读命令）
> 方法论：repo-migration-e2e-v2（方案先行 → 审计已完成 → 逐模块裁决 → 实施 → 对抗审查 → 收口）
> 参考：ZCode（/Users/wrr/work/ZCode）同域实现调研结论见 §1；不复制代码，只取设计优点。

## 0. 动机：我们与 ZCode 的差距（审计结论）

### 0.1 我们的劣势清单（要删/要改）

| # | 劣势 | 位置 | 用户感受 |
| --- | --- | --- | --- |
| L1 | **分支显示藏在「运行状态」管理页**——用户主工作区（会话页）看不到自己分支；只有运维视角的 worker 表副行 | agent-app runtime-worker-row | 日常无感：切了 worktree，正主界面（对话页）什么都不显示 |
| L2 | **2s 轮询现算**做分支显示——延迟+空转（无变化也每 2s 探测全部 live 线程） | x-harness host thread/list | 切分支后最多 2s 才更新；GUI 不开也在探 |
| L3 | **分支事实只读不可操作**——看见了分支却不能切/建，要开终端 | agent-app 全局 | 交互断层 |
| L4 | **运行中的线程可被外部切走基线**——用户在 app 内切分支不检查 agent 是否在跑（拆台风险我们自己都知道：hub 侧 thread/list gitBranch 每轮都在变，但 agent 的 cwd 事实已漂） | 无任何锁 | agent 跑在 A 分支，用户切到 B，后续 bash 全落 B——静默拆台 |
| L5 | **副行文案是纯文本**「项目名 @ 分支」——无状态色、无 worktree 归属指示、切错无提示 | runtime-worker-row | 信息密度低，worktree 与主仓行不可辨 |
| L6 | 脏/干净状态不可见——用户不知道哪个 worktree 有未提交改动（清理 worktree 时 kept-dirty 会留树，用户不知为何） | 无 | 神秘残留 |

### 0.2 ZCode 的优点清单（要取）

| # | 优点 | ZCode 位置 | 取法 |
| --- | --- | --- | --- |
| A1 | **分支切换器在主工作区头部**（ConversationStatusPanel 内嵌 GitBranchSwitcher）——日常视角第一眼 | ui/v4/ConversationStatusPanel.tsx | 移到我们的会话页 composer 区（已有 branch-menu，但入口埋得深） |
| A2 | **fs.watch 事件驱动刷新**——watch gitdir（HEAD 写入即触发）+ 防抖 150ms，不轮询 | services/git autoRefreshWatchPaths + ui/useGitAutoRefresh | hub 侧 thread/list 不变；app 侧对 activeCwd 加 watcher 失效缓存 |
| A3 | **watch 边界用 git 自己解析的 gitdir/commonDir**（linked worktree 时元数据在 repoRoot 外——不猜 .git 布局） | gitCliRepo.ts:buildAutoRefreshWatchPaths | 同思路：git/branches 响应带 gitDir 路径，UI watch 它 |
| A4 | **切换助手**（dirty 时不硬切：引导 commit/stash 的分步弹窗，列出受影响文件） | git-branch-switcher/switchAssist.ts | 取交互骨架，简化为「确认弹窗 + 文件数」 |
| A5 | **branch-in-other-worktree 专门错误码**——切分支遇占用给明确文案而非 git 报错墙 | shared/git.ts issue codes | git/checkout 失败分类透传到 UI 文案 |
| A6 | **切换锁**（工作目录有线程在跑→分支面板只读） | 无（这是我们已有的 branchSwitchLocked——ZCode 反而没有！保留我们的） | 保留，并升级：锁态显示「N 个会话运行中」而非静默禁用 |
| A7 | **信息分层**：头部只放「分支 + dirty 计数」；完整面板（graph/变更列表）按需展开 | GitBranchSwitcher + GitPane 分层 | 我们的 pulse-panel git-section 已有分层，补齐头部入口 |

### 0.3 双方都没有、本方案新设

- worktree **归属指示**（主仓 vs worktree 徽标）——我们独有的 worktree 感知能力顺势产品化；
- 分支失效代次（branchRevision）**由 hub 事件驱动**而非手动 bump（比 ZCode 的手动 bump 更进一步）。

## 1. 目标交互形态（用户故事）

1. 我在会话页正主界面**第一眼看到当前分支**：composer 区左侧常驻 `⑂ feat/worktree-context ·2`（分支名 + dirty 文件数徽标；worktree 会话额外加 `Ⓐ` 归属徽标悬停显示主仓路径）。
2. 点击分支名 → 弹分支菜单（搜索 + 当前高亮 + 建新分支入口）——**运行中线程锁**：activeCwd 有在跑会话时菜单只读，顶行显示「🔒 2 个会话运行中，停止后可切换」（A6 升级：锁原因可见）。
3. 切换遇 dirty → **不硬切**：确认弹窗列出「3 个文件未提交」，提供 [携带切换(git switch -c 新分支)] / [取消]（A4 简化版；不做 ZCode 的完整 commit 助手——我们的 agent 会自己做提交）。
4. 切到被其他 worktree 占用的分支 → 明确文案「该分支已被 worktree X 检出」（A5）。
5. **外部切换即时跟随**：终端里 git checkout，app 头部分支 ≤300ms 更新（A2 事件驱动；现有 2s 轮询仅作兜底）。
6. 运行状态页（管理视角）保留 worker 表，但副行升级为「项目 · 分支 · worktree 徽标 · dirty 点」结构化展示（L5 修复）。
7. 会话页打开 worktree 会话时，头部显示**该 worktree 的分支**（每会话各自的分支，不是全局 activeCwd——多线程多分支一眼可辨）。

## 2. 架构裁决

### 2.1 x-harness 侧（hub 协议，2 个只读加项 + 1 个字段）

- **`git/branches`（已有）响应加 `gitDir` 字段**：本仓 .git 路径（file 时为 gitdir 指向）——UI watch 锚（A3）。纯 fs 解析复用 `worktree-facts.ts` 单一真相。
- **`git/status --porcelain` 摘要（新只读命令 `git/dirty`）**：`{ count, files[] 截断 50 }`——头部 dirty 徽标数据源。**agent-app 已有 git/status**——本命令不加，**裁决：复用 app 现有 git/status**，只在 UI 层取 dirty 计数。~~（删掉本条——避免协议重复）~~
- **`thread/list` 保持现状**（现算+轮询兜底）；**新增 `git/changed` 事件（hub → app 推送）**：hub 检测到任一 live 线程 cwd 的 HEAD 变化时推送 `{ threadId, branch }`——app 收到即刷新（A2 的事件化，比 ZCode 的 UI 侧 watch 更省：一个 hub 进程 watch N 个 gitdir，N 个 app 实例零 watcher）。
  - 实现：hub host 侧 `fs.watch(gitDir)`（live 线程的 gitdir 集合，去重）+ 300ms 防抖 → 事件帧 + 自查 thread/list。Linux 不递归 watch workspace（ZCode 同款平台特判，只 watch gitdir 目录——恒安全）。

### 2.2 agent-app 侧（交互重构主体）

| 模块 | 裁决 | 说明 |
| --- | --- | --- |
| composer 区分支段 | **重写** | 现 branchSegmentOf 纯文本升级为结构化（分支名+dirty 徽标+worktree 徽标+锁态文案）；点击直达分支菜单（现入口在 pulse 面板，前移） |
| 分支菜单（composer 弹层） | **增强** | 现有 branch-menu 加：锁态顶行（原因可见）、当前分支高亮、其他 worktree 占用项禁用+标注、dirty 确认弹窗（简化版切换助手） |
| pulse-panel git-section | **保留** | 分层正确（详情按需展开）；数据源接 branchRevision 事件化 |
| runtime worker 表副行 | **重写** | 纯文本 → 结构化（项目 · 分支 · worktree 徽标 · dirty 点）；数据接 `git/changed` 事件即时更新 |
| use-git-branches/status hooks | **增强** | revision 信号源升级：ui-store 手动 bump + hub `git/changed` 事件双源（事件为主，bump 兜底） |
| branchSwitchLocked | **保留+升级** | 锁态从静默禁用升级为可见原因（N 会话运行中） |
| ZCode 的 GitPane/graph | **不移植** | 我们已有 git-graph 对话框 + diff-panel；不重复建设 |

### 2.3 明确不处理（归属）

- 提交/stash 完整助手（ZCode A4 全量）——agent 自己会做提交，人只裁决方向；后续若要再立件；
- git graph 可视化增强——已有能力，不动；
- 多仓库（multi-root workspace）——现架构 activeCwd 单仓语义，另件；
- hub 侧 watcher 的跨机器场景（remote hub）——事件只走本机 hub 连接，remote 由轮询兜底（≤2s 延迟可接受）。

## 3. 并发/性能预算

- hub watcher：每 live 线程 gitdir 一个 `fs.watch`（目录级、非递归）；≤ maxThreads(32) 去重后典型 ≤3；HEAD 写入 → 300ms 防抖 → 1 次事件帧 + 本进程自查。无轮询空转（对比现状：每 2s × N 线程 × 2 文件读——watcher 后 thread/list 轮询降频到 30s 兜底）。
- app 渲染：dirty 徽标数据复用 pulse 面板既有 git/status 拉取（打开面板才拉，头部只显示缓存的计数徽标——不新增请求面）。
- 分支切换串行：git/checkout 已在主进程串行（工作树独占资源——现状保留）。

## 4. 方向性裁决（D 序列）

| # | 裁决 | 理由 |
| --- | --- | --- |
| D1 | 事件驱动刷新的 watcher 放 **hub 侧**（非 app 侧 ZCode 式） | 一处 watch 服务多端；app 零 watcher 资源；remote 场景轮询兜底 |
| D2 | dirty 确认弹窗取**简化版**（文件数+两按钮） | 完整 commit 助手与 agent 职责重叠；交互重心是「知情裁决」不是「替 agent 干活」 |
| D3 | 分支事实**每会话各自显示**（非全局单值） | 多 worktree 线程并行是本产品核心形态；全局 activeCwd 单值会误导 |
| D4 | composer 头部入口 + pulse 详情**双层保留** | 日常一眼（头部）+ 深入操作（面板）——ZCode 同款分层 |
| D5 | `git/changed` 事件 freeze:none 不落 WAL | 纯 UI 失效信号，丢失由 30s 轮询兜底自愈 |
| D6 | 锁态从「静默禁用」升级为「可见原因」 | 静默禁用是人机交互反模式（用户不知为何点不了） |

## 5. 实施顺序（每步四门全绿）

1. **x-harness**：`git/branches` 响应加 `gitDir`；hub 侧 gitdir watcher + `git/changed` 事件帧（host 事件面接线）；单测（watcher 触发/防抖/去重/线程退出回收 watcher）；DESIGN.md 协议文档同变。
2. **agent-app contracts**：`git/changed` 事件契约、`gitDir` 字段、分支视图类型（worktree 占用标注）。
3. **agent-app hooks**：live-controller 订阅 `git/changed` → branchRevision bump（事件源）；use-git-branches 消费 `gitDir`（本地 watch 兜底，remote 场景）。
4. **agent-app composer**：分支段结构化重写（徽标/锁态文案/入口前移）；分支菜单增强（锁因/占用标注/dirty 弹窗）。
5. **agent-app runtime 页**：worker 表副行结构化（git/changed 即时更新）。
6. **e2e/回归**：外部 checkout → 头部 ≤300ms 更新（假 hub 事件注入）；锁态文案；dirty 弹窗流；worktree 占用文案。

## 6. 测试口径

- x-harness：watcher 单测（真 git 仓：checkout 触发恰一次事件（防抖窗内合并）、detached 不触发分支事件、线程 stop 回收 watcher、多线程同 gitdir 去重 1 个 watcher）；协议契约测试（事件帧形状、gitDir 字段）。
- agent-app：composer 分支段快照（分支/dirty/锁/worktree 四形态）；分支菜单（锁态顶行/占用禁用/dirty 弹窗确认流）；hooks（事件→revision→重拉链路，假 client 注入）；runtime 副行（事件即时更新断言）。
- 对抗审查（实施后）：独立会话对照 ZCode 优点清单逐项核验收（A1-A7 是否真落地、L1-L6 是否真消除）。

## 7. 风险与回退

- watcher 资源泄漏（线程退出未回收）→ hub 单测钉住 + 30s 轮询兜底自愈；
- 事件风暴（外部脚本频繁 checkout）→ 防抖 300ms + 事件合并（同 gitdir 多次变一帧）；
- 回退：`git/changed` 事件消费失败时 app 自动落回纯轮询（revision 机制不变，只是失效信号缺位）——降级路径天然存在。
