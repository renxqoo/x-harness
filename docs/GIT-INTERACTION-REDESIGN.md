# GIT 交互重构方案（借鉴 ZCode 优点 · 删自实现劣势 · 人机交互优先）

> 状态：**已定稿**（两面对抗审查回填——处置记录见 §8）
> 级别：中级（跨 x-harness / agent-app 两仓；UI 交互重构为主 + hub 事件一件）
> 方法论：repo-migration-e2e-v2（方案先行 → 审计 → 裁决 → 实施 → 对抗审查 → 收口）
> 参考：ZCode（/Users/wrr/work/ZCode）同域调研；不复制代码，只取设计优点。

## 0. 动机：我们与 ZCode 的差距（审计结论 · 审查修正后）

### 0.1 我们的劣势清单（要删/要改）

| # | 劣势 | 位置 | 用户感受 |
| --- | --- | --- | --- |
| L1 | 分支显示只在「运行状态」管理页副行——会话页 composer 虽有分支段（**审查 1.1 修正：可点可切可建已存在**），但 dirty 徽标缺失、worktree 归属不可辨 | composer-region.tsx + runtime-worker-row.tsx | 分支段信息密度低；worktree 会话与主仓会话头部不可辨 |
| L2 | 2s 轮询现算（thread/list）——延迟+空转 | x-harness host | 外部切换最多 2s 后才更新 |
| L3 | ~~只读不可操作~~（**审查 1.1 删除**：切换/创建/图谱已有；真劣势改为：**dirty 拒绝比 git 本身严**——tracked 脏即恒拒 `dirty_worktree`，git 允许不冲突改动随行；占用分支失败落 internal_error 无分类文案） | git-branches.ts:174-181 / :81-93 | 明明能切却被拦；切被占用分支看到 git 报错墙 |
| L4 | 外部切分支可拆台运行中 agent（我们有 branchSwitchLocked 但锁是无声禁用，且锁死了「于当前 HEAD 建新分支」这条安全出路） | branch-switch-lock.ts / composer-region.tsx:142-146 | 不知为何点不了；安全操作也被拦 |
| L5 | ~~副行纯文本~~ → 真劣势：**dirty/worktree 归属不可见**（hub 无 dirty 数据；副行无法显示） | runtime-worker-row.tsx | 哪个 worktree 有未提交改动不可知 |
| L6 | dirty 两种口径打架：BranchPanel 用 tracked-only `dirtyFiles`、pulse status 用含 untracked `fileCount`——同屏两个数字 | git-views.ts:15 vs status 视图 | 数字对不上，信任感崩 |

### 0.2 ZCode 优点（要取）

| # | 优点 | 取法 |
| --- | --- | --- |
| A1 | 分支切换器在主工作区头部 + dirty 计数 | composer 分支段**增量增强**（非重写——现状已是可点面板）：补 dirty 徽标（数据源=git/branches 已有 dirtyFiles）、worktree 徽标、锁因文案 |
| A2 | 事件驱动刷新（watch gitdir） | hub 侧 watcher + `git/changed` 事件（D1，细化见 §2.1） |
| A3 | watch 边界用 git 解析的 gitdir/commonDir 双目录 | **采纳双目录**（审查 F5 实测：HEAD 写落 gitdir、refs 写落 commonDir——单目录只够 HEAD） |
| A4 | dirty 切换不硬切 | **采纳 ZCode 精髓=试探式**：后端改试探 checkout（冲突文件才拦，错误码带文件清单）——取代现恒拒；UI 弹窗列冲突文件 [取消/重试强切提示]（不做完整 commit 助手——agent 自己会提交） |
| A5 | branch-in-other-worktree 专门错误码 | `git/checkout` 失败分类加 `branch_in_other_worktree`（携带占用者路径）；分支列表带占用标注（数据源见 §2.1-2） |
| A6 | （ZCode 没有——我们反超）切换锁 | 保留 + 升级：锁因可见（N 会话运行中）+ 放行「于当前 HEAD 建新分支」 |
| A7 | 信息分层 | 头部一眼 + pulse 详情按需——现状分层保留 |

### 0.3 新设（双方都没有）

- worktree 归属徽标（主仓 vs worktree——我们独有 worktree 感知的产品化）；
- 分支失效信号由 hub 事件驱动（ZCode 是 app 侧本地 watch——见 D1'）。

## 1. 目标交互形态（用户故事 · 审查修正后）

1. 会话页 composer 分支段常驻：`⑂ feat/x ·2`（分支 + tracked dirty 徽标——口径与 BranchPanel 统一 L6）；worktree 会话加归属徽标（悬停显示主仓路径）。
2. 点开分支面板（现状交互保留）：新增锁因顶行——activeCwd 有在跑会话时显示「🔒 2 个会话运行中」，并给**三条出路**：停止会话 / 于当前 HEAD 建新分支（安全，放行）/ 提示可在新 worktree 开会话（文案指引）。
3. 切换遇**真冲突**（git 试探判定覆盖 tracked 修改）→ 弹窗列冲突文件 + [取消]；不冲突的 dirty 随行（对齐 git 本身语义，删恒拒）。
4. 切到被其他 worktree 占用的分支 → 「该分支已被 <路径> 检出」+ 该项在列表中禁用标注（占用表见 §2.1-2）。
5. **外部切换即时跟随**：live 会话 ≤1s（审查 F6：事件延迟 ≤300ms + 重拉链路，端到端口径 1s）；parked 会话激活时重拉兜底（审查 F4：parked 无事件——激活/可见时重拉是明确兜底路径，不再宣称 30s 轮询兜底 composer）。
6. runtime worker 表副行：项目 · 分支 · worktree 徽标（**dirty 点不做**——hub 无此数据，审查 6.1 裁决：不为此扩协议；dirty 归 pulse 面板已有能力）。
7. 每会话各自分支：分支段随 activeSession.cwd（现状已如此——审查 4.1 核实；branchRevision 全局 bump 的多余重拉为已知可接受项）。

## 2. 架构裁决（审查修正后）

### 2.1 x-harness 侧（**只做一件**：git/changed 事件）

**审查 F1 修正**：`git/branches|checkout|status` 是 agent-app 主进程本地 verb（packages/api/src/verbs/ + main/git-exec.ts），**x-harness 无 git 命令**。原 §2.1 的 gitDir 字段/worktree-facts 复用/错误码全部移到 app 侧（§2.2）。hub 只做：

- **`git/changed` 事件**（帧形走现成 eventFrame 通路——审查 F2 契约化）：
  - 帧形状：`{ type:"event", threadId, name:"git/changed", payload:{ cwd, branch? } }` ——**逐 threadId 出帧**（帧契约强制单值 threadId）；payload 带 cwd（同 gitdir 兄弟会话靠 app 侧按 cwd 匹配刷新——审查 5.1②）；**detached 也发**（branch 缺席=已分离语义，防 UI 停在旧分支名——审查 F5）。
  - watcher 集合与生命周期（审查 F3 单一收敛点）：**表每次变更后重算期望集合 → diff 挂/收**（不按事件点挂钩）；sweep 1s 对账兜底（含 watcher 失效重建——F8 红线）。锚=live 线程（LIVE_PROBE_STATES 同口径）+ 归一后 cwd 的 gitdir **与 commonDir 双目录**（A3/F5：refs 写落 commonDir）；spawning 占位期 cwd raw 串不锚（首次归一回写后进集合）。
  - 防抖 150ms 尾沿（F6 统一数字），到期时刻**重读 HEAD** 取值 + 当时 live 集 fan-out（F7：不推事件时刻的陈旧值）；同值抑制（A→B→A 不发）。
  - watcher error → 指数退避重挂（F8）。
- app 侧消费跳（**方案补全——审查 F2**）：frame-decoder 无需改（复用 type:"event"）→ **event-mapper.ts 名单加 `git/changed`**（不改映射器事件死在主进程）→ UiEvent 新类型 → fold-events 加 case → mobile bridge 同源消费。
- thread/list 现算保持（runtime 页数据源不变）。

### 2.2 agent-app 主进程侧（git 族 verb 全在此）

| 工作项 | 落点 | 说明 |
| --- | --- | --- |
| `GitBranchesView` 加 `gitDir` | contracts/git-views.ts（**strict schema——生产/消费同步**）+ git-branches.ts（rev-parse --git-dir 已读现丢弃，捡回；**相对串 resolve(cwd)**——仓库根返回 `.git` 相对串的坑，ZCode 同款注释） | app 本地 watch 兜底锚（见 D1'） |
| `git/branches` 加占用表 `worktrees: [{branch, path}]` | `git worktree list --porcelain` 解析 | 分支列表禁用标注 + A5 文案数据源 |
| `git/checkout` 试探式 | git-branches.ts：删 tracked 脏恒拒 → 先 `git checkout --merge --no-commit` 试探？**否——用 git 原生失败面**：直接 checkout，`error: Your local changes...would be overwritten`（exit 1）时解析出文件清单 → `conflict_files` 错误码；不冲突 dirty 随行 | A4 骨架；删 L3 恒拒 |
| `branch_in_other_worktree` 错误码 | mapGitFailure 分类 + 携带占用者路径（stderr `already used by worktree at <path>` 可解析） | A5 |
| `branchSwitchLocked` 签名升级 | boolean → `{ locked: boolean; runningCount: number }` | 锁因文案数据源（审查 2.1 附带） |

### 2.3 agent-app 渲染层

| 模块 | 裁决 |
| --- | --- |
| composer 分支段 | **增量增强**：dirty 徽标（dirtyFiles 已在 git/branches 响应——只是没显示）+ worktree 徽标（gitDir 含 `/.git/worktrees/` 判定）+ 锁因 |
| BranchPanel（**两个装配点同步改**：composer 弹层 + pulse branch-menu——审查 1.1） | 锁因顶行（三出路）+ 占用项禁用标注 + 冲突文件弹窗；**旧锁路径清理**：pulse 触发器 `disabled={locked}` 静默禁用与 composer `branchPanelAvailable=false` 摘除 → 统一为可开+锁因行 |
| dirty 口径统一 | BranchPanel 与 pulse status 统一 tracked-only（L6）——status 视图改 untracked 排除或双列展示（裁决：统一 tracked-only，untracked 在 diff-panel 可见） |
| 分支切换放行 | 「于当前 HEAD 建新分支」不受锁拦（create 不改工作树不拆台——审查 2.1 论证） |
| use-git-branches | revision 双源：uiStore bump（现有）+ hub git/changed 事件（live-controller 订阅 → 按 cwd 匹配 bump）；app 本地 watch 兜底（主进程 fs.watch gitDir——**渲染层无 fs.watch，落主进程**，审查 5.2） |
| pulse git-section / runtime 副行 | 前者保留；后者升级结构化（无 dirty 点——§1.6 裁决） |

### 2.4 明确不处理（归属）

- 提交/stash 完整助手（agent 自己提交）；git graph 增强（已有）；multi-root（activeCwd 单仓语义）；remote hub 的事件覆盖（本机事件 + 轮询兜底）；runtime 副行 dirty（协议不扩——hub 无数据）；「在新 worktree 开会话」的动作面（本件只做锁因文案指引，动作另件）。

## 3. 并发/性能预算（修正）

- hub watcher：live 线程 gitdir+commonDir 双目录去重 ≤ 2×32；表变更 diff 挂收 + 1s sweep 对账（watcher 存活红线）；防抖 150ms 尾沿 + 同值抑制；**事件触发成本 = 重读 HEAD 1 次 + N 帧**。
- app：dirty 徽标零新增请求（git/branches 现有字段）；事件重拉 = revision bump → 1 次 git/branches（防抖窗内合并）。
- thread/list 轮询保持 2s（runtime 页数据源不变——不再降 30s，审查 5.1 指出降频会放大盲区）。

## 4. 方向性裁决

| # | 裁决 | 理由 |
| --- | --- | --- |
| D1' | hub 事件为主 + **app 主进程本地 watch 为常态兜底**（不再宣称「app 零 watcher」——审查 F4 矛盾裁决：parked 打开态与 hub 事件丢失都要本地源） | 双源失效信号，事件加速、本地兜底 |
| D2' | dirty 试探式 checkout（git 原生失败面解析冲突文件）——**删除恒拒** | 对齐 git 语义；「知情裁决」基于真冲突而非一刀切 |
| D3 | 每会话各自分支（随 activeSession.cwd——现状语义确认） | 多 worktree 并行核心形态 |
| D5 | git/changed freeze:none 不落 WAL；丢失由本地 watch/激活重拉兜底 | 纯失效信号 |
| D6 | 锁因可见 + 三出路（含放行 create） | 自设锁必须自带出路 |
| D7 | detached 也发事件（branch 缺席=已分离） | 防 UI 停留旧分支名（错误显示＞陈旧） |
| D8 | git/changed 逐 threadId 出帧 + payload 带 cwd | 帧契约单值 threadId；兄弟会话按 cwd 匹配 |

## 5. 实施顺序（每步四门全绿 · 审查修正后）

1. **x-harness**：gitdir watcher 服务（表 diff 收敛点 + 1s 对账 + 退避重挂）+ `git/changed` 事件帧（150ms 防抖尾沿读 HEAD + live fan-out + 同值抑制 + detached 语义）；单测（真 git：switch/建分支(双目录)/detach/树删重建/表生命周期 diff/防抖合并/去重 fan-out）；host DESIGN 协议文档（apps/host-hub/docs/DESIGN.md）同变。
2. **agent-app contracts + 主进程**：GitBranchesView 加 gitDir（相对串 resolve）+ worktrees 占用表；checkout 试探式 + conflict_files/branch_in_other_worktree 错误码；branchSwitchLocked 计数化；event-mapper/fold-events/UiEvent/mobile 桥接加 git/changed；主进程本地 watch 兜底。
3. **agent-app composer/panel**：dirty 徽标 + worktree 徽标 + 锁因行（三出路）+ 占用标注 + 冲突弹窗 + 双装配点旧锁路径统一 + dirty 口径统一。
4. **agent-app runtime 页**：副行结构化（分支+worktree 徽标；无 dirty 点）。
5. **e2e**：外部 switch → live 会话头部 ≤1s 更新（事件注入）；冲突弹窗流；占用文案；锁三出路；detached 后 UI 显示「已分离」。

## 6. 测试口径

- x-harness：watcher 生命周期（挂/收成对——表 8 变更点经 diff 收敛全覆盖）、双目录（建分支事件落 commonDir）、detached 事件、树删退避重挂、防抖合并/同值抑制、fan-out 快照时点、spawning 不锚。
- agent-app：gitDir 相对串 resolve；占用表解析；checkout 试探（冲突文件清单/随行成功/占用码）；锁计数；事件链路（frame→mapper→UiEvent→store→重拉，假 client 注入）；徽标双形态；弹窗流；口径统一断言。
- 对抗审查（实施后）：对照 §0.2 A1-A7 与 §0.1 L1-L6 逐项核销。

## 7. 风险与回退

- watcher 失效（树删/权限）→ 退避重挂 + 1s 对账（红线在收敛点设计内）；事件全失 → app 本地 watch 常态兜底（D1' 双源）；协议破坏（strict schema 加字段）→ 同步升版 contracts 两端。
- 回退：事件消费失败自动落纯轮询/本地 watch——降级路径天然。

## 8. 对抗审查处置记录

| 来源 | 发现 | 严重度 | 处置 |
| --- | --- | --- | --- |
| 交互 1.3 / hub F1（独立收敛） | git 族命令归属写错仓（x-harness 无 git 命令） | **阻断** | §2.1/§2.2 拆仓：hub 只做事件；gitDir/占用/错误码全在 app 主进程；worktree-facts 复用声明删除（跨仓依赖不成立） |
| 交互 6.1 | dirty 数据链断裂（副行 dirty 点无源） | **阻断** | §1.6/§2.3 裁决：runtime 副行不做 dirty 点（协议不扩）；composer 徽标用 git/branches 现有 dirtyFiles（非 pulse 私有） |
| 交互 3.1 | 「携带切换」语义不成立（恒拒+文案误导） | **阻断** | D2' 试探式 checkout 重裁决；删恒拒；弹窗改真冲突文件清单 |
| 交互 1.1 | 动机表与现状不符（L3 已可操作；BranchPanel 两装配点） | 应修 | §0.1 L3 重写；§2.3 点名双装配点 + 旧锁路径清理 |
| 交互 1.2 / A5 | 占用标注无数据源；占用失败落 internal_error | 应修 | §2.2 worktrees 占用表 + branch_in_other_worktree 码 |
| 交互 2.1 | 锁死路（漏 create 放行/worktree 指引）；锁计数签名 | 应修 | §1.2 三出路 + create 放行（D6）；branchSwitchLocked 计数化 |
| 交互 5.1 | 事件作用域/生命周期缺条款；parked 盲区；≤300ms 不实 | 应修 | D8（cwd+逐帧）；parked=激活重拉兜底（§1.5 改 1s 口径）；轮询不降频 |
| 交互 5.2 | 渲染层无 fs.watch | 应修 | 本地 watch 落主进程（§2.3） |
| hub F2 | 帧通路三跳漏（decoder/映射器/移动桥） | 应修 | §2.1 帧形契约 + §5-2 补 event-mapper/fold-events/mobile |
| hub F3 | watcher 挂收点 ≥8 处无钩子 | 应修 | 表 diff 单一收敛点 + 1s 对账（§2.1） |
| hub F4 | parked 盲区与「零 watcher」矛盾 | 应修 | D1' 双源重裁决 |
| hub F5 | 单目录不够 refs；detached 停旧名 | 应修 | A3 双目录采纳；D7 detached 事件 |
| hub F6 | 300ms/150ms 不一致；端到端承诺不实 | 可接受 | 统一 150ms 防抖；口径改 ≤1s |
| hub F7 | 一变多播/读取时点未定义 | 应修 | §2.1 尾沿读 HEAD + live 快照 fan-out |
| hub F8 | watcher 失效无重建（红线） | 应修 | 退避重挂 + 对账（并入 F3 收敛点） |
| 交互 4.1 | 每会话分支现状已自洽；全局 bump 多余重拉 | 可接受 | §1.7 改述；已知项落档 |
| 两面核实无问题 | 事件帧机制/fs.watch gitdir/串行锁/分层/不处理边界 | — | 直接进依据 |
