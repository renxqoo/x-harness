# delegation workspaceRoot 注入：git 调用脱 ambient cwd 方案

> 状态：已实施（v2 定稿 → 实施完成；两路方案审查 12 条处置见文末）
> 级别：中（跨模块：agent-delegation 包 + hub/CLI 两装配边 + e2e；外部契约 DelegationOptions 变形——新增必收字段）
> 关联：docs/AGENT-DELEGATION.md §8（worktree 隔离）；本方案修订其 §8.1 的 cwd 基准与并发前提

## 背景与症状

hub（Pai.app host-hub）形态下 `agent_spawn {isolation: "worktree"}` 被拒：

```
spawn-failed:worktree not-a-git-repo (git rev-parse --show-toplevel
→ fatal: not a git repository)
```

**根因**：`packages/agent-delegation/src/worktree.ts` 的 git 调用除 `worktree add` 外不传 cwd（`repoTopOf` 的 `rev-parse`、`evaluateCleanup` 的 `worktree remove`/`branch -D`），继承 worker 进程 `process.cwd()`。hub 的 `spawnWorker`（`apps/host-hub/src/host/worker-process.ts:42`）spawn worker 时不传 cwd → 所有 worker 的 cwd = 应用启动目录（实测 `/Users/wrr`，非 git 仓）→ `rev-parse` 失败。

线程真实工作区根在 hub 里是**存在**的（`thread/start` 的 `input.cwd` → `AssemblyFields.cwd` → toolboxKit/fenceKit/factsSnapshot 的 `root`/`cwd`），唯独 `createAgentDelegationPlugin` 没收到——它是装配链上唯一漏发 root 的 kit。

**连带缺陷（同一根因）**：
- `evaluateCleanup`（`verbs.ts:145` stop 主路径、`plugin.ts` 三处级联、`spawn.ts` 两处）的 remove/branch -D 在 hub 形态下失败且被 `.catch(() => {})` 静默吞掉 → worktree 目录与 `x-harness/<agentId>` 分支**永久泄漏**（description 承诺的 "auto-cleaned if unchanged" 兑现不了）；
- `sweepWorktrees`（启动对账清扫）在 hub 里恒返回 `[]`（rev-parse 失败静默退场）；
- `revive.ts` 的 `repoTopOf` 失败 → worktree 复活时 rootOverride 落不了账（隔离不重放，仅告警）；
- `existsSync` 早退分支（`worktree.ts:67`）：目录被外部删除时直接 `removed:true`，`x-harness/<agentId>` 分支不删——第三条静默泄漏路径。

CLI 直跑不炸纯属巧合：进程 cwd 恰好等于仓根。现有 e2e 旅程 `process.chdir(repo)` 后装配（`packages/e2e/src/delegation-journeys.ts:146`）——测试形态复刻了巧合，掩盖了缺陷。

**对抗审查另揭出的既有缺口（本件同批修）**：hub `resumeCwdOf`（`thread-commands.ts:194-197`）的 `header.cwd ?? fallback` 缺空串守卫（与 `preReadCwd` 口径不一）；revive 的 `gitExec` 不经串行队列；`CleanupResult` 把「策略保留」与「remove 失败」折叠（stop 文案谎报 "has changes"）。

## 契约

### API 变形（DelegationOptions，零兼容）

```ts
// packages/agent-delegation/src/types.ts
export interface DelegationOptions {
  readonly agentsDirs: readonly string[];      // 既有
  /** 工作区根（绝对路径）：本插件全部 git 调用的 cwd 锚点。须位于 git 仓内
   *  （仓根可为祖先——但不接受无关祖先仓，见 repoTopOf 校验）。不在仓内时
   *  isolation:worktree 以 not-a-git-repo 拒绝。 */
  readonly workspaceRoot: string;              // 新增，必收
  ...
}
```

- **构造期校验**（`plugin.ts`，fail-fast）：非空字符串且 `isAbsolute`，垃圾值 throw `agent-delegation: workspaceRoot must be an absolute path`。**校验序在 validateOptions 之后**（agentsDirs/limits 先拒——`delegation.test.ts` X7 用例不因新字段先炸而失覆盖）。不校验「目录存在」——目录消失是运行期事实，由 git 调用的失败拒绝面处理。
- **错误词表**：
  - `spawn-failed:worktree not-a-git-repo (...)` 保留（触发基准从「进程 cwd 不在仓内」修正为「workspaceRoot 不在仓内」）；
  - **新增** `spawn-failed:worktree workspace-not-in-repo`：rev-parse 找到的仓顶不是 workspaceRoot 自身或其祖先（无关祖先仓 / 嵌套仓边界），拒绝。
- **CleanupResult 判别拆分**（`worktree.ts`）：`{ kind: "removed" }` | `{ kind: "kept-dirty", path }` | `{ kind: "remove-failed", path, detail }`——stop 文案按形态分支（kept-dirty 才说 "has changes"；remove-failed 如实报失败）。**零兼容**：调用方全量迁移，旧 `{removed}` 形态删净。

### git 调用锚定规则（单一真相）

| 调用 | cwd 基准 |
| --- | --- |
| `rev-parse --show-toplevel`（repoTopOf） | workspaceRoot（注入值） |
| 仓顶归属校验 | repoTop 必须是 workspaceRoot 或其祖先，否则拒 workspace-not-in-repo |
| `worktree add` / `worktree remove` / `branch -D` | **repoTop**（spawn 时落账进 `WorktreePlan.repoTop` 的持久化事实——清理与复活消费持久化事实，不消费当次装配 cwd；跨装配 resume/fork 换 cwd 不漂移） |
| `evaluateCleanup` 入参 | 从 `{path, branch}` 改为 `WorktreePlan`（path/branch/repoTop 三元组）——修复丢 repoTop 的契约缺口 |
| `status --porcelain` | `git -C <worktree path>`（既有，不变） |

清理/复活侧不再引用 workspaceRoot——它们拿到的 plan 里带 repoTop。workspaceRoot 只服务 spawn 侧探测。

### 装配点（含 onWarn 接线）

| 位置 | 传值 |
| --- | --- |
| `apps/host-hub/src/worker/assembly.ts:385` | `workspaceRoot: cwd` + `onWarn: (m) => process.stderr.write(...)`（既有惯例同款） |
| `apps/cli/src/build-world.ts:181` | `workspaceRoot: options.cwd` + `onWarn: options.onIoError`（同 factsSnapshot 接线） |
| `packages/harness/src/index.ts` delegationKit | 零改动（透传 DelegationOptions） |
| `packages/agent-delegation/src/__test__/world.ts` makeOptions | 缺省 `workspaceRoot: process.cwd()`（既有测试不被迫全改）；worktree 用例显式传 repo |
| `packages/agent-delegation/src/__test__/delegation.test.ts` | X7 四处裸构造补合法 workspaceRoot（保 maxDepth/agentsDirs 分支覆盖不假绿） |
| `packages/e2e/src/` 四处直连装配 | 各传对应 cwd；worktree 旅程去 chdir（夹具 git 调用全改 `git -C`，见测试口径） |
| `docs/AGENT-DELEGATION.md` §7/§8.1 | git 调用 cwd 基准 = workspaceRoot/repoTop；并发前提修订（见下） |
| `docs/CLI.md:197`、`docs/SDK-DESIGN.md:57` | stale 装配示意同批更新（零参示例本已与必收 agentsDirs 不符） |

## 问题域

**处理**：
- delegation 包内全部 git 调用显式携带 cwd（锚定规则见上）；
- 清理失败可见化（onWarn + CleanupResult 判别拆分），含 existsSync 早退分支的分支删除；
- sweep 的 livePaths 接线（lineage 活行 worktree 路径）；
- 跨进程 git 写互斥（per-repo lockfile，见并发预算）；
- hub `resumeCwdOf` 空串守卫（既有缺口，新校验会把它升级成 worker 自杀——必须同批）；
- revive gitExec 并入串行队列。

**不处理**（写清归属）：
- **hub `spawnWorker` 传 cwd**——独立改进，归 hub 侧后续。本方案消灭 delegation 内全部 ambient 读取后无剩余消费方；
- **嵌套 worktree 语义**（worktree 子再 spawn isolation:worktree 时子树从主仓 HEAD 建）——既有行为保持，归后续件；
- **hub `thread/start` cwd 缺席时的进程 cwd 兜底**（`thread-commands.ts:311`）与 `thread/register` 的 host 进程 cwd 兜底（`host-commands.ts:244`）——装配链上游事实，归 hub 件；本方案以 repoTop 归属校验（workspace-not-in-repo）兜住其最坏后果（worktree 写进无关祖先仓）；
- **GIT_DIR/GIT_WORK_TREE 环境注入**——无需求。

## 并发/一致性预算

- **进程内**：git 调用仍经 `gitChain` 全局串行（revive 的裸 gitExec 并入——现状陈述不实的修正）；注入 root 后不同 root 的调用混队只损吞吐无损语义。
- **跨进程（hub 多 worker 同仓）**：`gitChain` 互斥蒸发。防线 = **per-repo lockfile**：`<worktreeParent>/…-lock`（repo 外同级，`O_CREAT|O_EXCL` + pid+mtime stale 检测，持锁者崩溃后可抢）。**写操作**（worktree add / worktree remove / branch -D / sweep 全程）持锁；**读操作**（rev-parse / status）不持锁。sweep 持锁全程（枚举+逐树评估+删除一个临界区）。
- **sweep 误删防线**（三层）：① livePaths 接线（本进程 lineage 活行）；② per-repo lockfile（跨进程写互斥——他进程 spawn 持锁时 sweep 不入临界区）；③ FRESH_MS 1h 纵深（既有）。防线 ② 堵住「A 在 spawn 中 B 在 sweep」；「A 的活树跑超 1h 未产生目录 mtime 更新」仍可被 B 误删——残余风险接受并落档 §13（多进程 live 集共享需跨进程 lineage 注册表，属任务体系件）。
- workspaceRoot 是装配期快照；resume/fork 重装配随 fields.cwd 重算。清理/复活消费 repoTop（持久化事实）不受重装配影响。

## 拆分

```
packages/agent-delegation/src/
  types.ts      DelegationOptions + workspaceRoot（必收）
  plugin.ts     校验（validateOptions 后）；spawnDeps/verbDeps/reviveDeps/sweep 线程化；
                sweep livePaths 接线（lineage 活行）
  spawn.ts      SpawnDeps + workspaceRoot；prepareWorktree 传 worktree.ts
  verbs.ts      VerbDeps + workspaceRoot（stop 清理主路径）；CleanupResult 新判别文案
  worktree.ts   repoTopOf(root)+归属校验；createWorktree(agentId, root)；
                evaluateCleanup(plan: WorktreePlan)（git -C repoTop）；
                sweepWorktrees(live, root, now?)（now 缝保留第三参）；
                per-repo lockfile；CleanupResult 判别拆分；existsSync 早退补 branch -D
  revive.ts     repoTopOf 经 gitChain；复活 rootOverride guard 取 worktree 所属仓
                （header.worktree 同仓 repoTop——plan 事实，非当次装配）
  lockfile.ts   （新）per-repo lockfile：acquire/release/stale 检测
apps/host-hub/src/worker/assembly.ts   workspaceRoot + onWarn
apps/host-hub/src/worker/thread-commands.ts  resumeCwdOf 空串守卫
apps/cli/src/build-world.ts            workspaceRoot + onWarn
packages/e2e/src/delegation-journeys.ts worktree 旅程去 chdir（夹具 git -C 化）
docs/AGENT-DELEGATION.md §7/§8.1/§13   基准/并发前提/残余风险落档
docs/CLI.md、docs/SDK-DESIGN.md        stale 示意更新
```

依赖方向不变：agent-delegation 不 import 宿主。

## 实施顺序

单批次（改动面收敛）：
1. 包内：types → plugin 校验 → lockfile → worktree/verbs/spawn/revive 线程化 → 测试装置；
2. hub（assembly + thread-commands 守卫）+ CLI；
3. e2e：worktree 旅程去 chdir + 夹具 `git -C` 化；
4. 文档同变（AGENT-DELEGATION/CLI/SDK-DESIGN）；
5. 四门 → 对抗审查（diff 级，两独立子 agent）→ 处置 → 提交。

## 裁决

- **方案 A（必收参数）而非服务 token**：用户裁决（对话确认）。外部先例 Codex `config.cwd = turn.cwd`、ZCode `workspaceRoot: string` 必收字段；内部先例 toolboxKit/fenceKit/factsSnapshot 全参数传入。装配期静态事实，param 是自然形态。
- **repoTop 归属校验**（不向上撞无关仓）：采纳自对抗审查（两路之一 P5）。rev-parse 找到的仓顶不是 workspaceRoot 或其祖先 → 拒。dotfiles $HOME / 外层 monorepo 场景兜住。
- **清理锚定 repoTop 而非 workspaceRoot**：采纳（两路 P6/P7）。清理/复活消费持久化事实，跨装配不漂移。
- **per-repo lockfile 而非仅 FRESH_MS**：采纳（两路 P3/P4）。跨进程写互斥是 hub 形态下「串行消除风险」承诺的唯一兑现方式。
- **makeOptions 缺省 `process.cwd()`**：默认裁决（否决窗口）——避免三十余处既有测试被迫加字段；缺省只住测试装置，生产装配恒显式传。
- **构造期只校验形状不校验存在性**：默认裁决——目录存在性是运行期事实。
- **嵌套 worktree 建树基准不改**：默认裁决，归后续件。
- **sweep 残余误删风险接受并落档**：跨进程 lineage 注册表属任务体系件。

## 测试口径

**契约断言**：
- workspaceRoot 缺席/空串/相对路径 → 构造期 throw（表驱动：`""`、`"relative/path"`、`"."`）；
- X7 四处裸构造补合法 workspaceRoot 后仍锚 maxDepth/agentsDirs 分支（不假绿）；
- CleanupResult 三判别穷举（removed / kept-dirty / remove-failed）文案分支。

**回归用例（症状命名，走 `task_stop` 面）**：
- **「hub 形态：进程 cwd 在仓外，workspaceRoot 指向真仓」**——spawn 成功（进程 cwd 停非仓目录）；
- **「hub 形态清理不泄漏」**：spawn → `task_stop` → 目录与分支双消失；
- **「remove 失败可见 + 文案如实」**：`git worktree lock <path>` 制造（实测退出 128，单 `--force` 不越锁）→ onWarn 收到 cleanup failed + stop 文案报 remove-failed（非 "has changes"）；
- **「existsSync 早退补删分支」**：外部 rm worktree 目录 → stop 后分支仍被清；
- **「workspaceRoot 在无关祖先仓」**：workspaceRoot 位于仓 A 内、rev-parse 命中祖先仓 B → workspace-not-in-repo 拒；
- **「workspaceRoot 在仓内子目录」**：rev-parse 找到仓根，建树基准 = 仓根（合法，通过）；
- **「跨装配清理不漂移」**：resume 换 cwd 后 stop 清理仍删对树（repoTop 持久化事实）；
- **「resume 空串 cwd 守卫」**：header.cwd="" 时回落 worker 现值，不产出垃圾 workspaceRoot。

**e2e**：worktree 旅程去 `process.chdir`，夹具 git 调用全 `git -C repo` 化（init/config/add/commit/branch --list——原 ambient 形态去 chdir 后会写错仓）。

**边界**：lockfile stale 抢占（持锁者 pid 不活）；FRESH_MS 窗内不清（既有 now 注入用例保留）。

## 验收清单

- [ ] hub 形态（进程 cwd 在仓外）spawn worktree 成功
- [ ] hub 形态 `task_stop` 后 worktree 目录 + 分支双清（经 stop 面锚定）
- [ ] remove 失败走 onWarn + stop 文案如实（remove-failed ≠ has changes）
- [ ] existsSync 早退分支的分支删除
- [x] workspace-not-in-repo 拒绝（GIT_WORK_TREE 外指形态——真拒绝用例在库；GIT_DIR 注入不声明防御，§13 落档）
- [ ] repoTop 归属校验（仓内子目录合法通过）
- [ ] per-repo lockfile：跨进程写互斥 + stale 抢占
- [ ] resumeCwdOf 空串守卫
- [ ] 构造期校验表驱动 + X7 不假绿
- [ ] e2e worktree 旅程复刻 hub 形态（无 chdir，夹具 git -C 化）
- [ ] docs 四处同变（AGENT-DELEGATION/CLI/SDK-DESIGN/本方案状态）
- [ ] 四门全绿 + 覆盖率 ≥90/85 只升不降
- [ ] diff 级对抗审查（两独立子 agent）问题清零

## 对抗审查处置记录（两路合并 12 条）

1. verbs.ts/VerbDeps 漏清单 → 采纳（拆分/测试口径补）
2. onWarn 装配空转 → 采纳（装配点表补 onWarn 列）
3. sweep 互删活树 → 采纳（livePaths 接线 + lockfile + 残余风险落档）
4. gitChain 跨进程蒸发 → 采纳（per-repo lockfile）
5. 无关祖先仓 → 采纳（repoTop 归属校验，新拒绝词）
6. evaluateCleanup 丢 repoTop → 采纳（入参改 WorktreePlan，清理锚 repoTop）
7. 「预占目录」假锚 → 采纳（改 git worktree lock 制造）
8. CleanupResult 折叠谎报 → 采纳（判别拆分三分支）
9. 构造方/文档清单漏 → 采纳（delegation.test.ts X7、CLI.md、SDK-DESIGN.md 补全；校验序定死）
10. existsSync 早退漏删分支 → 采纳（早退补 branch -D + onWarn）
11. revive gitExec 不经队列 → 采纳（并入 gitChain）
12. resumeCwdOf 空串守卫 → 采纳（hub 同批修）

两路各自明示「未找到问题」的项：同一仓多线程路径/分支 8hex 碰撞（~2^-32 声明接受）、agentsDirs 缺省链无偏差面（CLI 边沿 cwd==process.cwd()）、resolveAgentDirs/probeBaseFacts 显式传参无 ambient 面——维持不动。

## diff 级对抗审查处置记录（B 路 11 条）

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | revive 的 repoTop 用 `rev-parse --show-toplevel` 在 linked worktree 内返回 worktree 自身（实测）→ guard=worktree 打穿 §8.2 过滤 + 清理锚错（锁路径嵌套垃圾目录、branch -D ENOENT、目录已删分支泄漏、文案谎报） | **修**：改读 `.git` 文件 gitdir 行解析主仓顶（`mainRepoTopOf`）；guard 与 spawn 侧同构；回归锚「复活 repoTop 取主仓顶」 |
| 2 | ownsWorkspace 词法比较不消 symlink（/var vs /private/var）→ hub resumeCwdOf 未归一的逻辑形 cwd 恒误拒 | **修**：比较前 realpath 归一（`physical()`）；symlink 逻辑形回归锚 |
| 3 | CLI onWarn 死接线（main.ts 不传 onIoError）；plugin 5 处清理失败静默 | **修**：buildWorld 缺省 stderr 兜底；plugin 加 `cleanupQuietly` 统一出口（adoptOrphan/evictIdle/级联）；spawn.ts spawnFailed/abortSpawn 接 onWarn |
| 4 | lockfile mkdir 非 EEXIST 失败无出路 → task_stop 热循环挂死 | **修**：父目录不可建与非 EEXIST 错误均降级直跑临界区（不劣化于无锁现状） |
| 5 | sweep `indexOf("agent-")` 对含 "agent-" 的仓名错位（既有 B-P1-4 未根治） | **修**：`lastIndexOf("-agent-")`（agentId 恒为 8hex 后缀） |
| 6 | 「跨装配清理」测试没换装配没走 stop；resume 空串守卫零测试；表驱动缺 "." | **修**：真换装配 + task_stop 用例（含跨装配 not-found 边界）；worker-units 补 resumeCwdOf 守卫表驱动；"." 入表 |
| 7 | e2e 四处装配传 process.cwd() 且未关 sweep → 会删真仓 worktree | **修**：四处统一 `worktreeSweep: false`（world.ts A-P1-2 同口径） |
| 8 | plugin 兜底链（`?? workspaceRoot`）与 verbs（`?? worktree ?? workspaceRoot`）不一致 | **修**：统一三段链（repoTop → worktree 自身 git -C 归位 → workspaceRoot） |
| 9 | sweep「全程持锁」声明与代码不符（readdir 在锁外） | **修**：readdir 移入锁内临界区 |
| 10 | lockAgeMs 死导出 | **删** |
| 11 | worktree 用例贴超时抖动 | 包级并行档（19 文件同跑）stale 抢占用例可复现 5000ms 超时（单文件/单用例 1ms 即完成——并行 import/transform 期事件循环饥饿）；真仓夹具 describe 显式放宽 timeout 20s（N6 复审后改实） |

另：B 路 P2 审查揭示原「无关祖先仓拒」测试的绿靠词法比较 bug（逻辑形 vs 物理形必非「祖先」）。归一修复后语义收敛：物理在仓内必是祖先——「无关祖先仓」在自然文件系统下不可达，`workspace-not-in-repo` 保留为 GIT_DIR 注入等防御面的拒绝词。测试改为 symlink 逻辑形不误拒的回归锚。

## diff 级对抗审查处置记录（A 路 9 条 + 测试口径 3 条）

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | revive repoTop=worktree 自身（rev-parse 在 linked worktree 内的行为）| 与 B 路 #1 同源——已在 B 路处置（.git gitdir 解析） |
| 2 | 清理可见化只兑现 stop 一条路 + sweep kept 谎报 has changes | 六处清理点全接 onWarn（B 路 #3 同源）；sweep 返回 `SweepKept{path, kind}` 形态对，kept-dirty/remove-failed 分开报 |
| 3 | sweep 锚 repoTop 但枚举共享父目录——兄弟仓的树被跨仓 remove（必 128）→ 永久假告警 | **修**：entry 前缀过滤（`<repoName>-agent-` 只处理本仓条目）；兄弟仓共存回归锚 |
| 4 | ownsWorkspace 不消 symlink | 与 B 路 #2 同源——已修（physical 归一） |
| 5 | livePaths 死接线（apply 时刻 lineage 恒空；同进程重装配互扫） | **修**：进程级活树登记簿（`registerLiveTree`/`unregisterLiveTree`/`liveTreePaths`）——spawn/revive 登记、清理终局摘除、sweep 消费跨实例活树集；回归锚 |
| 6 | withRepoLock 无超时（pid 复用/只读目录永久挂死）；pidAlive 把 EPERM 当死 | **修**：60s 等锁上限超时降级直跑；writeFile 失败降级直跑；EPERM=活（且修正首版把 ESRCH 误判活的倒置——A 路审查后自查发现的实现笔误） |
| 7 | createWorktree 半建兜底 branch -D 锁外裸奔 | **修**：入 withRepoLock |
| 8 | sweep 枚举在临界区外 | 与 B 路 #9 同源——已修（readdir 入锁） |
| 9 | 清理兜底链两套口径 | 与 B 路 #8 同源——已统一（repoTop → worktree → workspaceRoot 三段链） |
| 10 | 「hub 形态」测试名虚标（cwd 是 x-harness 仓内而非非 git 仓） | **部分采纳**：测试进程 cwd 无法脱离本仓运行（vitest 必须在仓内跑）；非 git 仓 cwd 形态已由「workspaceRoot 指非仓目录拒 not-a-git-repo」用例等价覆盖（锚的是 workspaceRoot 不是 cwd——修复后语义即如此）。用例名保持但补充此说明 |
| 11 | 半建产物断言被无必要放宽 | **还原**硬断言（grants 前置拒从未建锁——放宽无据） |
| 12 | 夹具 realpathSync 遮蔽 symlink 缺陷 | 已由 symlink 逻辑形回归锚补上（B 路 #2 处置附带）；锁互斥用例 30ms sleep 改为确定性先持锁（await 30ms 后启动第二个） |

A 路核实无问题项（mkdir 原子性/stale 竞态/release 复核/重入/装配点/resumeCwdOf/worktree lock 锚）不再重复处置。

## B 路验收复审处置记录（第二轮 N1–N7）

| # | 问题 | 处置 |
| --- | --- | --- |
| N1 | 活树登记簿只增不减（task_stop/abortSpawn 不摘除——内存泄漏红线） | **修**：stop 非 kept-dirty 即摘除（kept-dirty 树仍活可复活）；abortSpawn 同（登记晚于 createChildSession，abort 可达）；spawnFailed 摘除注释诚实化（该路径登记未发生=no-op） |
| N2 | mainRepoTopOf 全套件零执行覆盖（回归锚只断言 git 行为，未执行解析器；e2e revive 旅程 spawn 不带 isolation） | **修**：revive.test.ts 增 worktree 子复活用例（真走 replayWorktree，断言 rootOverrideOf(child).guard === 主仓顶 非 worktree 路径 + 行落账 worktreeRepoTop） |
| N3 | 三处契约面仍描述已不可达的「无关祖先仓拒」 | **修**：types.ts / AGENT-DELEGATION §8.1 / 本方案验收清单同批改为收敛语义（祖先仓=工作区的仓接受；防御面=GIT_WORK_TREE 异指注入） |
| N4 | 兜底链中段 `?? row.worktree` 非 repoTop（worktree≠仓顶——remove 成功后 branch -D 的 cwd 是已删目录 → 分支泄漏） | **修**：中段改 mainRepoTopOf(worktree)（失败落 workspaceRoot）；stop 侧同链 |
| N5 | lockfile 四条降级路径零观测 | **修**：withRepoLock 增可选 onDegraded；两装配点接 stderr（hub 既有 onWarn 同链） |
| N6 | #11 处置不实（包级并行仍超时；「21 条」过期） | **修**：真仓夹具 describe 放宽 timeout 20s；处置表复现条件改实（本表 #11 行） |
| N7 | 病态命名理论边（仓恰名 `<A>-agent-*` 撞前缀；仓名以 `-agent-<8hex>` 结尾错位） | **落档** §13 已知理论边——需刻意命名，接受 |

## A 路验收复审处置记录（①–⑩）

| # | 问题 | 处置 |
| --- | --- | --- |
| ① | plugin 三处兜底链未统一（N4 病灶在三清理路径存活：裸 worktree 中段 → remove 成功后 branch -D ENOENT → 分支泄漏 + 嵌套锁目录） | **修**：三段链收敛单一函数 `cleanupRepoTopOf`（verbs 导出，stop 与 plugin 三处共用——两链漂移结构性根治） |
| ② | workspace-not-in-repo 声明与实测不符（GIT_DIR 注入 toplevel 落工作区内、防不住）；验收唯一勾选项无测试 | **修**：三处契约面改实（防御面=GIT_WORK_TREE 外指；GIT_DIR 不声明防御落档 §13 部署纪律）；新增真拒绝用例（进程级 env 注入 → spawn 面断言拒绝词） |
| ③ | 活树登记簿第 4 条泄漏路径：kick 失败行（纯内存部署 evictIdle 恒跳过）→ 登记簿永久持有 → sweep 永久跳过=泄漏树免死金牌 | **修**：kickChild 失败分支自带清理+摘除（fire-and-forget + onWarn）；teardown cascade 对句柄缺席行不再早退（行自持清理事实，照清+摘除） |
| ④ | stop 与 evictIdle 并发双清理 → 第二落者 branch -D 已删分支退出 1 → 假 "cleanup failed" 告警 | **修**：早退分支分支已不存在 = 幂等达成（stderr not found 短路 + branch --list 复核）→ removed，不谎报 |
| ⑤ | lockDegradedSink 模块级全局 last-writer-wins：重装配窗口降级错报新实例、dispose 不复位 | **修**：改 per-call 注入（options 闭包随插件实例），删全局 sink；createWorktree/evaluateCleanup/sweepWorktrees 签名加可选 onDegraded |
| ⑥ | 锁互斥用例 30ms sleep 假设（处置表声称「确定性」不实） | **修**：受控放行重写（a 入临界区 resolve 测试 → 断言 b 未启动 → 放行 a）——零时间窗假设 |
| ⑦ | mkdir 非 EEXIST 一律降级：瞬时 ENOENT（父目录被并发删）与永久权限错误不分；code 缺失输出 "mkdir undefined" | **修**：ENOENT 瞬时形态一次自愈重试（重建父再试，deadline 内）；告警串 unknown error 兜底 |
| ⑧ | N2 用例未断言 worktreeRepoTop 落账（清理锚回归面空） | **修**（二轮换锚）：净树形态——复活后撤脏文件 → stop → 断言分支消失（记错仓则残留→红） |
| ⑨ | >30s 事件循环停顿下 stale 误抢可致短暂双持锁 | **落档**：权衡写入 CREATING_WINDOW_MS 注释（最坏收敛于无锁基线，收窄同理不优——接受） |
| ⑩ | RepoLock 接口死导出（与 lockAgeMs 同性质） | **删** |
| 附 | #10 「hub 形态」用例名与事实不符 | **改名**：「workspaceRoot 锚定（进程 cwd 非夹具仓）」 |

## A 路二轮复审处置记录（①'/③'/⑧'/A/B/C/D）

| # | 问题 | 处置 |
| --- | --- | --- |
| ①' | 「无第二实现」证伪：kickChild 内联残留一条裸 worktree 中段（今日不可达死代码，但处置声明不实） | **修**：换用 cleanupRepoTopOf（kickChild 改 async；调用点 fire-and-forget 语义不变） |
| ③' | kickChild 注释心智模型倒置（register 实先于 kick，三路兜底在场——自清理是「最早的一路」非「唯一的路」）；双清无害机理已被审查方验证为真 | **修写**：注释按真实时序改写（含双清机理：repo 锁串行 + branchGone 幂等） |
| ⑧' | 落账锚在 kept-dirty 短路——记对记错断言都过，零检测力 | **修**：换净树形态锚（撤脏文件 → stop → 断言分支消失） |
| A | 测试夹具跨文件竞态：tmpdir 直下多仓共享同一 `<T>/.x-harness-worktrees`，afterEach 互删（审查方实测包级 25 循环 12 失败；此前两处「适应性放宽」实为竞态补丁） | **根治**：夹具独占父目录（fixtureDir 两级 mkdtemp——各仓 worktrees 目录零共享）；放宽断言还原硬断言；包级 5 连跑全绿 |
| D-1/D-2/D-3 | ENOENT 自愈无退避 / 锁降级窗双清假告警残余（窄窗语义无损）/ ② 用例 env 隔离前置条件 | D-3 注释补；D-1/D-2 备忘接受（窄窗、不越无锁基线） |

## A 路三轮复审处置记录（发现 1/2/3）

| # | 问题 | 处置 |
| --- | --- | --- |
| 1（高） | 自查疑点 1 命中：kickChild async 化 + void 调用断掉 throw→dispatch 归一路（spawn 谎报成功 + unhandled rejection 可崩 Bun worker）；kick 失败路径零测试覆盖 | **修**：kickChild 不再 throw——返回 `{ok:false, reason}`，buildChild await 后归一返回（同步错误契约与改前同义，无 unhandled 面）；补回归锚（sealing stub followup 抛错 → 断言错误结果 + finished 闭环 + 树/分支清 + 摘除登记）；处置表「fire-and-forget 语义不变」更正为「await 归一」 |
| 2（高） | revive 夹具 finally 的 rm 目标 `dirname(dirname(parent))` = os.tmpdir() 本身——destructive 红线（沙箱实测整删 T 目录；真实环境 .catch 静默 + rm 中途失败侥幸） | **修**：改 `dirname(parent)`（独占根）；注释明示不可再上一级 |
| 3（低） | 独占根泄漏：revive 侧因发现 2 从未删除（116K/跑真实累积）；worktree 侧 afterEach 与 fire-and-forget 清理竞态留空壳（0 字节恒定） | revive 侧随发现 2 根治；worktree 空壳接受（无累积成本——落档本行） |

审查方验证背书：包级 25 连跑全绿（竞态根治复测）；⑧' 测试时序逐环验证自洽（含锚链兜底分叉）。
