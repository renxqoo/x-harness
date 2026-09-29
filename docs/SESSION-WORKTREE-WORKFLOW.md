# 会话级 Worktree 工作流方案

> 状态：**已定稿 v5.0**（两轮六审查组全部通过且终验归零：一轮初审 35→复查 24→终审 17；二轮产品 P/R/N 三批、数据 P0/P1/断点/盲向量/终验、架构 #1–#12/二验/核销追加——累计处置约 180 项；CAS 判别双向纠错定于「两态 + show-ref 复核」；进入实施——§7 阶段 1）
> 级别：中（跨 x-harness / agent-app 两仓、新 verb 契约 ×4 + 新 hub 命令 ×1 + host 路由新谓词、UI 交互面）
> 方法论：feature-dev-v2（方案先行 → 测试口径先行 → 分阶段实现 + 四门 → 两轮对抗审查 → e2e → 收口）
> 前置讨论裁决：本会话历轮（创建开关形态 / 切换=通告而非迁移 / KV 缓存红线 / 显式清理 / **最优与可扩展性优先于最小改动**）
> 关联文档：docs/AGENT-MESSAGE.md、docs/AGENT-DELEGATION.md §8、agent-app docs/GIT-INTERACTION-REDESIGN.md
> 审查记录：§10（一轮初审 35 项 + 复查新增 24 项，处置随条目标注）

## 0. 背景与目标

用户（人）和 agent（模型）都需要「在不打扰其他会话的前提下，在独立 git worktree 里开展分支工作」。
现状：agent 侧已有完整能力（`agent-delegation`），**人类侧的入口、可见性、生命周期全部缺失**：

- 新建会话没有「开独立 worktree」入口（GIT-INTERACTION-REDESIGN §2.4 显式延期至今）；
- 手开的 worktree 在 UI 不可见不可选（工作区弹窗只列「已知目录」；隐藏目录系统对话框不显示）；
- 会话中的 agent 建了 worktree 分支后，同一会话的 agent 不知道树在哪（Environment 块装配期快照，永不刷新）。

本方案补齐三块：**入口（三形态：新建开关/会话内建树/前往）、可见性（占用表 + list）、生命周期（显式清理）**，并经 `thread/notify` 通用通道让 busy 会话获知树事实。

### 0.1 核心约束（红线）

| # | 约束 | 来源 |
| --- | --- | --- |
| R1 | **KV 缓存前缀稳定**：system prompt（含 Environment 块）装配期铸死、会话生命周期零变更。动态事实的存续保证不是「append 天然缓存安全」（surface 投影整体非只追加——replace 步进摘区间、压缩改写前缀），而是 `agent/message{content}` 经 serialize 内容行存续于摘要（两次压缩之间 KV 前缀稳定） | 用户裁决 + 一审 P7 |
| R2 | **会话 cwd 是出生事实**：不提供会话中途换 cwd；「会话去树里」= 开新会话（前往） | 架构事实 + 用户裁决 |
| R3 | **用户树永不自动清理；清理显式且过数据安全门** | 用户裁决 |
| R4 | **零兼容层**：纯加法；x-harness 侧改动 = host-hub 协议四文件 + agent-loop notify/领取面 + 文档，agent-delegation 产品代码零改动（测试向量另计） | 项目规矩 + 二轮架构 #3 |
### 0.2 方案级裁决原则（用户裁决，随二审方法论修正落档）

**裁决依据 = 最优与可扩展性优先；改动量只是成本项，不是否决项。**「暂无消费者」对通用通道（thread/notify）不构成砍除依据——它使「宿主 → 会话内模型」的事实注入成为一等能力，首期消费方是 git-worktree 通告，后续环境事实类需求（外部变更通知等）复用同一协议面，不逐需求造协议。

## 1. 契约

### 1.1 agent-app 新 verb 族 `git/worktree/*`

```ts
// packages/contracts/src/api.ts 追加
'git/worktree/list': {
  params: z.object({ cwd: z.string().min(1) }).strict(),
  result: z.object({ worktrees: z.array(WorktreeEntryViewSchema) }).strict(),
},
'git/worktree/create': {
  params: z.object({ cwd: z.string().min(1), branch: z.string().min(1) }).strict(),
  result: z.object({ path: z.string(), branch: z.string() }).strict(),
},
'git/worktree/remove': {
  params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }).strict(), // cwd=任意仓内目录（repoTop 锚与锁锚）；path=树绝对路径（本体键）
  result: z.null(),
},
'git/worktree/merge': {
  params: z.object({ cwd: z.string().min(1), branch: z.string().min(1) }).strict(), // cwd=主仓本体目录（merge 发生地——树内 cwd 被 §2.1 预检门拒）；branch=树分支
  result: z.object({ branch: z.string(), merged: z.literal(true) }).strict(),
},
```

**remove 参数 `{cwd, path}`**（复查 N3：目录缺席时 path 自身无仓可锚——`git -C <不存在目录> rev-parse` exit 128；cwd 由调用面天然持有，并兼作跨进程锁与 repoTop 的锚）。

**WorktreeEntryView**（packages/contracts/src/git-views.ts）：

```ts
export const WorktreeEntryViewSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),    // null = detached HEAD
  clean: z.boolean(),               // status --porcelain 空（含 untracked——口径钉死；目录缺席 = 字段省略形态，见 prunable）
  merged: z.boolean(),              // 数据安全门结果（§1.4 判据；detached 树 = HEAD sha 被任一本地分支包含；目录缺席 = merged 门仍可评——rev-list 不需要工作树）
  unmergedCount: z.number().int().optional(), // tip 不可达自其他本地分支的提交数（rev-list --count <tip> --not <其他>，含 merge 纯计数——确认框文案数据；判据是 is-ancestor 布尔，本数非判据）
  locked: z.boolean().optional(),    // porcelain locked 透传（UI 前置禁用清理按钮——二轮架构 #6）
  prunable: z.boolean().optional(),  // 目录缺席/登记失真（porcelain 透传；孤儿态呈现）
});
```

**create 语义**（预检链按序，复查 N1 关键修正）：

1. `isValidBranchName`（既有）→ 拒 `invalid_branch`；
2. **分支存在预检**：`git show-ref --verify refs/heads/<branch>`（精确匹配；git 组终审 S2：for-each-ref 是前缀匹配——查 `feat` 会命中 `feat/login` 造成误拒）→ 已存在 → 拒 `branch_exists`（**此失败路上绝不跑半建兜底**——兜底会删用户既有分支）；
3. `git symbolic-ref -q HEAD` 失败（detached）→ 拒 `worktree_detached_head`；
4. HEAD 有效性预检（unborn：`rev-parse --verify HEAD` 失败）→ 拒 `worktree_detached_head`（message 注明 unborn）；
5. **树内 cwd 门（verb 侧）**：`--git-common-dir` 归一后 ≠ `--git-dir` 归一后 → cwd 已在 linked worktree 内 → 拒 `worktree_nested`（新码；复查 N9——防 UI 漏拦时在树旁造嵌套用户区）；
6. 计算树路径（§5 D3 编码）→ `existsSync` → 拒 `worktree_path_exists`（先于 git，杜绝 stderr `already exists` 误报）；
7. `git worktree add -b <branch> <path> HEAD`（**持 §3 跨进程 repo 锁**）；失败 → **条件半建兜底（二轮数据 P1-7 三步 + 二轮数据复查断点一 CAS 统一）**：a) `rev-parse --verify refs/heads/<branch>^{commit}` 成功 **且** 解析值 == 本次起点 commit（证明为本轮半建残留——条件门防删用户既有分支，复查 N1）→ **CAS 删**（`update-ref -d refs/heads/<branch> <起点 sha>`——半建分支 tip 恒 == 起点，CAS 即「确认无用户数据」；非 0 → show-ref 复核：缺席 = 幂等成功，在场 = 异常如实报）；b) 半途死登记残留 → `worktree prune` 后重试 a 一次（x-harness cleanupHeld 同款先例 worktree.ts:143-144；否则该形态分支留+登记留+目录残缺，同分支重 create 撞 branch_exists、走 remove 自救撞 clean 门脏——双门锁死，实测复现）；c) 目录回收：add 前路径不存在（本轮创建）而 add 失败 → 递归删除半建目录（防下次 create 撞 `worktree_path_exists` 永久卡死）→ `git_failed:*`；**全方案删分支单轨 = CAS**（branch -D 退役——含本兜底路径）；
8. 成功 → 树路径登记 `userWorktreeDirs`（§1.6 白名单，独立集合）。

**remove 语义**（verb 恒重评、不信任 UI 传参）：

1. repoTop 解析：`git -C <cwd> rev-parse --git-common-dir` → `resolve(cwd, out)`（**相对串先 resolve 再 dirname**——复查 N6：主仓/子目录返回 `.git`/`../.git` 相对串，直接 realpath 按进程 cwd 解析出错路径，git-branches.ts:207 同款坑）→ dirname → realpath；
2. **live 占用门**（数据源 §1.7）：目标树被 live 会话（cwd === 树路径或前缀命中）或运行中子代理行占用 → 拒 `worktree_in_use`；
3. **merged 门（无条件、含 gone-dir 形态；判据按 §1.4 is-ancestor 表）**：`git merge-base --is-ancestor <tip> <其他本地分支>` 逐一探测，任一真 → 放行；全假 → 拒 `worktree_dirty`。**「其他本地分支」枚举口径钉死（二轮数据 P1-4）**：`git for-each-ref refs/heads --format='%(refname)'` **显式过滤目标自身**、全 refname 传参——自身入列则 `is-ancestor(b,b)` 恒 exit 0 → 门恒放行 → 全量丢失（`--branches` 诱惑同陷阱：恒含自身）；**is-ancestor exit 三态语义（二轮数据复查盲向量 B，实测）**：`0` = 包含 → 放行；`1` = 不包含 → **继续探测下一分支**（正常假，勿当失败——误当 fail-closed 则门恒拒清理全灭）；`≥2` = 命令级失败（对象损坏/仓外致命错等）→ fail-closed 拒（对齐 §1.7 原则）；tip 与分支名均从 porcelain 取（attached：`branch` 行；detached：`HEAD` 行——反查口径按形态）；**目录缺席时本门照评**（porcelain HEAD 行仍输出，二轮 P0-3 修正）；
4. **clean 门（仅目录在场时）**：`existsSync(path)` 且 `status --porcelain --ignored` 非空 → 拒 `worktree_dirty`（message 区分改动/未跟踪/被忽略三类计数——**二轮数据 P0-1：`--ignored` 必加**，实测 `.env` 类被忽略文件随树静默删除且 remove 非 force 不自检 ignored；`!!` 条目即 ignored 面）；`status` 命令失败（broken .git 形态，二轮 P1-8）→ **fail-closed 拒**，message 指路 `git worktree prune`（登记清除后目录与数据完整留盘，实测验证）；目录缺席 → 跳过本门（prunable 形态）——**但 merged 门照评**（porcelain 的 `HEAD` 行仍输出，二轮 P0-3 修正 L171 矛盾：gone-dir + detached 可评非不可评，仅 HEAD 行缺席才 fail-closed）；
5. `git worktree remove <path>`（非 force；目录缺席时 git 对 gone dir 实测成功）；
6. **删分支（CAS——二轮数据 P0-2 根治 + 二轮数据复查三态修正）**：门评估时刻 pin 住 tip（`rev-parse --verify refs/heads/<branch>^{commit}` 全 sha），删除用 **`git update-ref -d refs/heads/<branch> <pinned-tip>`**（命令行式）。**exit 判别两态 + show-ref 复核（实测：mismatch 与 missing 同为 exit 1——命令行式下不可凭 exit code 区分；勿依赖 stderr 文案）**：`0` = 删除成功；**非 0 → `git show-ref --verify refs/heads/<branch>` 复核**——缺席 = **幂等成功**（并发先行者/用户已删，终态已达不谎报——x-harness branchGone 同款纪律 worktree.ts:129-135；复核命令与 create 步骤 2 预检同款，零新面）；在场 = tip 漂移（锁外写者在门后新 commit）→ 落入步骤 7 失败语义（树已删、分支与内容仍在，可恢复）。**实测复现的锁外丢失链就此闭合**：x-harness 锁只包 worktree add/remove/branch 写，agent bash commit 完全在锁外——「门（锁内）→ remove（锁内）→ 删（锁内）」对锁外写者无意义，CAS 把安全性从「锁的覆盖面」转移到「tip 比对」这一原子事实上（`branch -D` 无 tip 检查恒删，弃用；`-d` 的 HEAD/upstream 口径错位仍弃，同复查 N2；**plumbing 无 checked-out 保护由本方案步骤 2 占用门 + 步骤 5 remove 先行承担**——实测 update-ref -d 可删被树占用分支，保护面在方案不在 git）。**detached 树无 ref 可 CAS** → 防线 = **remove 前锁内重跑 merged 门**（读主仓侧 `.git/worktrees/<name>/HEAD` 或 porcelain HEAD 行——与门评估同锚：目录在场与缺席两形态同源可读，实测 `git -C <path>` 在 gone-dir 下不可执行而主仓侧登记恒在；门后 commit 同步更新该文件，重跑必抓漂移）；
7. **删分支失败（CAS 非 0 且 show-ref 复核在场 = tip 漂移 / 分支名反查失败）**→ 如实报错带 branch 名（此时树已删、分支与内容仍在，可恢复）；**复核缺席 = 幂等成功**（见步骤 6 判别）；**detached 树跳过步骤 6/7**（无分支可删 → remove 成功即终态；其 commits 无分支 ref、删除后 worktree HEAD reflog 同失——fsck unreachable 是唯一恢复面，故步骤 3 的 sha 包含门对 detached 是最后防线）；步骤 5/6 的 git 操作 cwd 锚步骤 1 的 repoTop（防 cwd=树自身时锚漂移，与锁键同根）。

**list 语义**：`git worktree list --porcelain`（`refs/heads/` 全名传参后续判据）排除主仓条目；逐树评估 clean/merged/unmergedCount（**merged 门对 gone-dir 树照评**）；**逐树降级不崩**（单树 git 失败 → 该树字段省略形态）。porcelain 的 `locked` 字段透传（供 UI 呈现）。纯读无锁。

**错误码闭集增量**：`worktree_dirty`、`worktree_path_exists`、`worktree_detached_head`、`worktree_nested`、`worktree_in_use`、`worktree_locked`（六个新码 en/zh 双语落键；locked = `cannot remove a locked working tree` 分类——git 组终审 U2，确认框提示先 `git worktree unlock`）。

### 1.2 hub 新命令 `thread/notify`（live-only 转发，新路由谓词）

```ts
"thread/notify": { threadId: string, source: string, kind: "directive" | "content", text: string }
```

**路由语义**：不入既有「线程域命令自动唤醒」路径（worker-pool routeLine 的 wake 分支与 retiring requeue 分支）。host 路由层新增 **live-only 谓词**，**判定顺序先于 retiring requeue 判定**（复查 (a)：分支插在表项查找与 retiring requeue 之间，实现者放错位置即违反「不入 requeue」声明）：

- `deliverIfLive` 命中且**表项 state**（判定数据源——LiveSlot 无态字段，worker-pool.ts:438 同款）为 live 非 retiring 非 spawning → 投递 worker；**spawning 归 not-live**（二轮架构 #9：wake 在飞 slot 已同步注册 byThread（worker-pool.ts:358），deliverIfLive 会命中投给未完成 resume 的 worker → requireThread 应答 unknown_thread，错误面与 thread_not_live 不一致）；
- 未命中、retiring 或 spawning → **host 本地应答 `thread_not_live`**（不 wake、不 requeue；retiring 视同 not-live——复查 N1：通告投给拆除中的 worker 会落 WAL 但材料化推迟到下次 kick，数小时后冒出过期通告，比拒更差）；
- 入 **OBSERVER_COMMANDS**（不重置 worker idle）；
- **worker 分派 target 单点判定（hub 契约不携 target 字段；判定与入队须在同一同步块完成——worker 命令循环串行，同步块内无交错面，引入 await 即开新竞态格）**：读 `driver.status()`——
  - **running** → `agent.notify(source, kind, text)` 走 next-step + 唤醒（AGENT-MESSAGE §4 场景 C 既有语义）；
  - **idle** → **next-turn 入队不唤醒**（§1.3 idle 策略；agent-loop notify 扩 target 队列参数——队列选择住 worker 侧，主进程心跳 isStreaming 与 driver.status() 两信号源在判定→投递竞窗内可翻转，收敛单点）；
  - **结算边界翻转**（已选 next-step 而状态翻 idle）→ 丢弃 + 应答成功（尽力而为；复查 G：此形态不丢弃会产生只有通告的 LLM 调用）；
- 形状门：source 非空 / kind 闭集 / text 非空 / threadId 已知；hub 不收敛 source 词表。

**词表五处同步**（跨仓不可同提交，改「同批同步落地」）：x-harness `internal.ts`（THREAD_SCOPED + live-only 谓词 + OBSERVER）→ x-harness `commands.ts` → agent-app `contracts/hub-commands.ts` → agent-app `contracts/commands.ts`（PaiCommandType + PAI_COMMAND_TYPES 编译期断言 + 词表断言测试）→ agent-app `packages/api/src/commands/thread.ts`（HubApi.thread.notify）。

### 1.3 用户树通告（source = `"git-worktree"`，kind = `"content"`）

**来源会话判定（终审交互 N1 修正）**：判定键 = **打开新建页时刻的 activeThreadId（定格于 ui-store openNewTask 扩字段 sourceThreadId）**，而非 newTaskCwd 是否非空——代码事实：四个 openNewTask 调用点全传 `''` 或分组键（workspace-main.tsx:65 等），`defaultCwd = enterCwd || activeCwd` 回退到活跃会话目录（use-new-task-screen.ts:104）——「busy 会话旁 ⌘N」主路径上预选目录就是来源会话的目录。定格会话有效条件 = threadId 存活且**线程态为 live**（live/busy 同在 create 完成时刻重估）（parked/retiring/dead 视为无来源——二轮架构 #4：hub 缺省 15min idle 即 retire（limits.ts:65），retired 会话 thread/notify 拒 thread_not_live、通告无处落账，「无静默丢弃」承诺在默认配置下为假；反馈文案如实「来源会话已回收，不注入」）且其 cwd === 本次 create 的 cwd（不匹配则视为无来源）。

**投递面（含 idle 策略——终审交互 N2/N3）**：

| 入口 | 发起/来源会话状态 | 通告 |
| --- | --- | --- |
| 新建任务页（无定格来源或定格失效） | — | **不注入**（新会话 Environment 块天然正确） |
| 新建任务页（定格来源有效） | 来源 busy → notify（并入在飞轮，步边界材料化） | busy 注入 |
| 同上 | 来源 idle → **next-turn 排队不唤醒**（agent-loop 扩 target 队列参数：idle 投 next-turn、busy 投 next-step） | 排队注入（下轮生效） |
| 会话内建树 | 发起会话 busy → notify（next-step） | busy 注入 |
| 同上 | idle → 同上 next-turn 排队 | 排队注入 |
| 前往 / 清理 | — | 不注入 |

**通告 text 模板**（二轮产品 P3——入口价值全押在此文案上，钉死模板防实现者随手写失效文案）：

```
[git-worktree] branch <branch> is now checked out at <path> for this task.
Subsequent file operations for this task should use that directory as the working root;
do not modify the main worktree at <cwd>.
```

**用户反馈（终审交互 N3/S1 + 二轮 P5 按入口分支）**：建树成功后 UI 反馈**按入口分句**——会话内建树/来源会话在档：「树已建于 <path>；会话空闲时通告将在下条消息生效」（busy 判定在 create 完成时刻重估）；新建页（无来源）：「会话将在 <path> 中开始」（不提通告）。主进程 create 时登记 `threadId → 树路径`（会话内建树入口天然持有发起会话 id）——composer 上下文条据此渲染持久「派生树」chip（点击可前往/清理，**长期指示**显示与实际工作区的分离——二轮 P5：一次性 toast 不足以支撑心智模型）。

**origin 条目领取规则（二轮架构 #2——inbox 语义适配，防「纯通告轮」）**：`claimTurnBatch` 现状只领 next-turn 队首（inbox.ts:75）——idle 排队的通告先于用户消息入队会独占首轮 dial（用户消息被推到链式下一轮），恰制造复查 G 要消灭的「只有通告的 LLM 调用」；且 `chainsNextTurn` 对非空 next-turn 恒链式（driver.ts:62）——仅剩 origin 条目也会在任意轮收尾后拉起纯通告轮。**领取规则改为：step0 领取「前导 origin 条目 + 首条非 origin 条目」（前导合并进同批材料化）**。**规则仅约束 next-turn 侧；next-step 侧语义不变**（step0 与步边界均全领——next-turn 仅剩 origin 而 next-step 有 steer 条目时 step0 照领 steer、通告留队，不得搁浅 steer）。**不链式判定 = 两队列析取**：next-turn 与 next-step 均无「非 origin 条目」时 chainsNextTurn 才返回 false（任一队列含非 origin 即链式）。**前导 origin 批量上限 ≤8**：超出**留队列下轮领取**（非丢弃——content 类通告丢最旧 = 丢事实；上限只防单批材料化撑爆，零丢失同样达成）+ 材料化批次末附「另有 N 条排队通告」计数行。

**改动落点全集（二轮架构复查补三项消费方——漏改任一即数据/语义缺陷）**：

1. `inbox.ts` claimTurnBatch（领取规则本体）；
2. `driver.ts` chainsNextTurn（仅剩 origin 不链式）；
3. `types.ts:39`/`plugin.ts:116` notify 签名扩 target；
4. **`step.ts` reinsertClaimed（193-197）**：回灌硬编码取 next-turn 队首——新规则下 step0 领取批含前导 origins + 首条非 origin，blocked 回灌须同规则整批回插，否则**被领走的用户消息从队列消失**（claim 已落 WAL、insert 只回一条）；
5. **`repair.ts` claimReinserts（56-90）**：崩溃修复按 claim 事件 target 分组回灌——混合批 claimed ids 含跨队列来源时会整体错灌 next-turn（steer 变 followup 跨轮才消费）；修法：**按 insert 事件自身 target 分组**（insertsById 已有全部信息；claim target 仅作发起队列记录，语义钉死）；
6. **`driver.ts:265` 锁存唤醒 replay 谓词**：现用 nextTurn.length > 0 原始长度——仅剩 origin 且 wakeRequested 置位时空 kick（空批 → empty→completed 白落一对 turn 括号）；replay 谓词与 chainsNextTurn 同用「含非 origin」判定。

**子代理树通告：整族不做**（一审 P3 终审维持：删树六路径中三处在 emitSpawned 后，建树通告会留下摘要恒保留的假事实；stop 路径既有工具结果已带同语义尾注；`agent_message` 寻址经 agentId 不依赖树路径（nameaddr.ts:14-26 实码核实）、`list_agents` 视图本带 worktree 字段——发现通道既有）。

来源登记：docs/AGENT-MESSAGE.md §5 迁移地图表 + PLUGIN-AUTHORING 已知来源表各一行。

### 1.4 数据安全门判据（按域分治）

| 域 | 判据 | 理由 |
| --- | --- | --- |
| x-harness 子代理树（既有，不动） | 分支头被其他本地分支包含（branch --contains） | 子代理不 merge；已带回归落地 |
| agent-app 用户树（本方案，二轮数据 P1-6 改判） | **tip 被任一其他本地分支包含：`git merge-base --is-ancestor <tip> <其他本地分支>` 任一真 → 放行；全假 → 拒**（与子代理域同构，D4 意图同源彻底达成） | 二轮实测系统性比对：rev-list --no-merges 相对 is-ancestor 的**唯一增量放行面 = C1（独有冲突解决在 merge commit）恰是丢失面**；is-ancestor 在该形态拒（安全）；「纯同步 merge（分支侧 merge main）」is-ancestor 小误拒——实测 tree 差 0，删了不丢内容，误拒可接受（确认框该形态文案见已知边界）；squash/cherry-pick 两判据同恒拒（保守正确一致） |
| detached 用户树（二轮数据 P0-3 补行） | **同公式**：tip sha（porcelain `HEAD` 行取——`branch` 行反查对 detached 恒不可用，仅 attached 形态适用）被任一本地分支包含 | 二轮实测：机械代入 `--no-merges` 公式在 detached merge-commit tip 上恒放行（丢失侧）；is-ancestor 同一公式天然覆盖 attached/detached——三域判据归一 |

**已知边界如实落档**（二轮数据 P1-6 收敛后重写）：

- **squash-merge / cherry-pick 合入**：恒拒（两判据一致）——确认框口径句「squash-merge / cherry-pick 方式合入的提交仍会被计为未合并」；
- **纯同步 merge（分支侧 merge main 同步、无自有提交）**：is-ancestor 恒拒（tip 是 merge commit 不被 main 包含）——实测 tree 差 0、删了不丢内容，**小误拒接受**；该形态确认框附差值信号文案：「分支包含同步合并记录但无独有内容，如确认可先手动 `git branch -f` 重置到基线后清理」；
- C1（独有冲突解决在 merge commit）：**恒拒**（is-ancestor 天然覆盖——实测该形态删分支后内容失去全部 ref，恒拒是唯一安全档）；
- **子模块内本地改动（二轮数据复查 F2，实测：超仓视角 `--porcelain --ignored` 对子模块内 tracked 改动与 untracked 均输出空）**：**首期落档不做**——clean 门不递归子模块（做则加 `submodule foreach` 递归 status）；已知边界明文化「子模块内本地改动不在删除防线内，随树删除」；向量补该形态（断言现状行为——防线缺口如实锚定而非假装覆盖）；
- **上游探测文案**（二轮数据 P1-5）：分支有上游且 `rev-parse @{upstream}` 可解析 → 确认框附「该分支已推送到 `<remote>`，删除本地分支后可从远端取回」；**判据仅看 refs/heads 不含 refs/remotes**（落档裁决：refs/remotes 是本地缓存的过时事实——PR 合并自动删远端后 tracking ref 残留，计入则把「远端已无副本」的 squash 分支放行删除 = 原始 commit 从宇宙消失）；
- 判据漂移防线：共享**测试向量**双仓各持（`+` 前缀自条目 / detached 树 / merge commit 头 / `??` untracked / prunable / `--no-merges` 各形态 / 单分支仓 `--not` 空集 / squash-merge 形态）；clean 口径契约注释钉死「含 untracked」。

### 1.5 UI 契约

| 交互点 | 形态 |
| --- | --- |
| 新建任务页开关 | 状态机：cwd 空 → 禁用（「先选择工作区」）；`selectCwd` → 开关与分支名一并重置（沿用 model/thinkingLevel 纪律）；分支视图 loading/failed → 禁用（failed 态原因文案「分支信息不可用」——复查 H）；非 git → 禁用 + 原因；cwd 在树内 → 禁用 + **正向指引文案**（「已在 worktree 中——直接开始即可」，二轮 P10：技术正确不得变成体验突兀）；branchLocked 锁态 → **可用**（worktree add 不动主仓） |
| 开关开启形态 | 分支名输入（placeholder `feat-<日期>` 连字符）；空名禁用提交；目录段保留可换 |
| **会话内建树** | 分支面板新增动作「在独立 worktree 开始此任务」：弹分支名输入（同款校验）→ create → busy 时注入通告（§1.3）；树路径登记白名单 |
| 创建提交原子性 | 新建页：create 成功 → session/start；start 失败 → 自动回滚 remove（树必 clean 零提交，门必过）。**已知残留落档**（复查 #10）：回滚触发点在渲染层，窗口关闭/进程崩溃于两步之间仍可留孤儿树——由「清理」双入口兜底（不声称「不留孤儿树」） |
| 分支面板 worktree 行 | 占用行三动作：「前往」（打开新建任务页预填树 cwd，`openNewTask(cwd)` 既有出口）、「合并回主仓」（§2.1 merge verb；受 branchSwitchLocked 锁域——锁态禁用 + 锁因文案）与「清理」；detached 用户树（branch=null 无占用行）→ **占用表加 detached 行**（path 呈现 + 清理动作；复查 #4 残留闭合；detached 无合并动作——无分支可合） |
| 清理确认对话框 | **数据源 = `git/worktree/list`**（复查 D）；**两级呈现**（二轮产品 P8——多轮正确性修补不得叠加成 git 专家审查面板）：主句只讲后果与数量（「将永久删除目录与分支 `<b>`；N 个提交未并入任何本地分支」+ 危险态着色）；squash 口径句/同步合并误拒指路句（§1.4 纯同步 merge 形态）/prunable 说明收**折叠详情且条件显示**（unmergedCount>0 才现口径句、对应形态才现指路句）；文案人话化（prunable→「目录已不存在，git 仍有登记」；locked 给解释性人话不甩终端命令；**locked 树禁用清理按钮**（数据流 list 的 locked 字段前置，非点了才报错——二轮 P2-10））；en/zh 双语 |
| 会话卡片 | worktree 会话（cwd 命中用户区）「清理」入口（与分支面板同 verb；in_use 拒时 message 带占用会话名单 + 「关闭会话后可清理」指引——二轮产品 P4） |
| **worktree 会话呈现面**（二轮产品 P2 补齐） | composer 项目段 `[wt]` 徽标（D3' 判据；悬停显示主仓路径与分支）；侧栏项目组**并入主仓名组**（组键 = 主仓 repoTop 而非整条 cwd——否则侧栏出现 `x-harness-feat-login` 密文新组；组内条目副行显示分支名）；runtime 副行既有正则扩第二目录名 |
| 不做 | worktree 管理页、会话内热切 cwd、反向迁移、UI 强删（未过门树无「仍要删除」后门——R3） |

### 1.6 目录白名单（独立集合 + 持久化）

复查 #1/E 修正：**另立 `userWorktreeDirs` 集合**，不并入 `pickedDirectories`（该集合同时是技能/插件导入批准根——复用即静默扩大信任面）；只并入 `extraCwds` 消费面（isKnownCwd 放行：分支段/附件搜索）；**持久化**（主进程 JSON 状态文件，随 create/remove 增删）——解决重启后「前往」落地页 `cwd_not_allowed` 残留；**GC**（终审 S3）：remove 成功顺带清理对应条目 + 启动时 existsSync 过滤陈旧项（防白名单只增不减）。

**登记面统一条目（二轮产品复查 R7/R8/R9——同一 JSON 状态文件三张表）**：

1. `userWorktreeDirs`（白名单，上段）；
2. `threadId → 树路径`（派生树 chip）：**接线 = 渲染层 create 成功回调经既有 workspaceActions 通道写主进程登记**（verb params 不扩——UI 提示数据走 UI 通道；「verb 恒重评」约束的是安全门，不约束提示面登记）；**登记对象写死**：新建页路径登记**来源会话**（新会话未出生无 id）——chip 挂主仓旧会话表「派生关系」；树内新会话靠 [wt] 徽标表「自身位置」——两者语义不同不得混；会话内建树登记发起会话自身；**单值映射 last-wins**（同一会话二次建树覆盖前值——chip 显最新一棵，旧树仍经分支面板可达，二轮产品 N6）；**GC 对齐同款**：remove 成功顺带清条目 + 启动时按树存在性过滤（防死路径 chip 指向不存在 cwd 使「前往/清理」变报错发生器）；
3. `树路径 → repoTop`（侧栏组键与徽标悬停数据源）：create 时主进程已知 repoTop 顺带存——**D3 编码 `<repo>-<encoded(branch)>` 切分不可逆**（`my-app`+`feat-login` 与 `my`+`app-feat-login` 同串），渲染层无 fs/git 无法词法推导，映射表是唯一可靠源（同时避免侧栏渲染路径上做 git 子进程探测）；启动时与白名单同批过滤。**子代理区树不在此表**（非本方案所建）——[wt] 徽标悬停遇映射缺席降级为只显示分支名（二轮产品 N7）。

### 1.7 live 占用门数据源（终审 V2 改判：冷路径取数）

占用事实两份，均**冷路径取数**（remove 执行时拉取，非轮询热路径）：

- live 会话 cwd：host `thread/list` 既有（HubApi 直查，无新协议面）；
- 运行中子代理行：agent-app 侧对 live 线程逐个 `get_subagents`（**PARKED_DIRECT 集成员**——parked/dead 由 host 直读免唤醒、空形态恒 success（parked-reads.ts:10）；live 线程真转发，worker 内 delegation 行带 worktree 路径（lineage.ts:27））→ **判据钉死（二轮架构 #7）：`row.worktree` 在场 → 与目标树路径做前缀关系判定（目标树路径 === row.worktree 或为其子路径——嵌套树形态）**；row.worktree 缺席（复活行字段可缺席，lineage.ts:28-30）→ 该行按占用处理（fail-closed 同基调）。**不做公式重建**（worktreePaths 时代残留——公式 repoTop 在嵌套形态下与目标树主仓 repoTop 不同，重建即错）。

**缺席语义 fail-closed**（终审 V2）：live 线程的 get_subagents 应答缺席（worker 死亡/超时）→ 该线程按「占用」处理（remove 拒 worktree_in_use）——安全门在不可判时宁可误拒不误删；worker 确死（表项转 dead）不在此列。

**门覆盖 live + parked**（终审 V4）：parked 表项 cwd 在 thread/list 全表返回中在场，零成本纳入前缀比对（防「树删后才 resume 的会话」悬空）；dead 除外。

**gone-dir + detached 形态**（终审 V4）：branch=null 且目录缺席 → porcelain 反查不可用 → merged 门不可评 → **fail-closed 拒** worktree_dirty（message 注明登记失真，指路手动 git）。

## 2. 问题域

**处理**：人类创建/列举/合并回主仓/删除会话级 worktree（verb ×4）；三入口（新建开关/会话内建树/前往）；显式清理（双入口 + 确认框）；busy/idle 会话获知树事实（thread/notify 投递）；白名单独立集合持久化；live 占用门。

### 2.1 merge-back 收编路径（二轮产品 P1 阻断补齐——生命周期闭环的中间环节）

**裁决：完整档**。生命周期间 = 出生（create）→ **收编（merge-back）** → 销毁（remove）；缺收编则清理门（要求 merged=true）把用户锁死在自己最有价值的工作前——树越有价值越删不掉。

**新 verb `git/worktree/merge`**（schema 已并入 §1.1 代码块——单一真相）：

- **预检两道（二轮产品复查 R1/R4——verb 恒重评原则对 merge 同样适用）**：a) 树内 cwd 门：`--git-common-dir` ≠ `--git-dir` 归一（create 步骤 5 同款判定）→ 拒 `worktree_nested`——分支面板占用行是 repo 级数据源，**树内会话的分支面板同样出现该动作**，树内 cwd 发起 merge 会「Already up to date」假成功（主仓分毫未动 UI 报完成）或把 feat-x 合进树里检出的其他分支（错误合并真实发生）；b) 主仓 detached 门：`symbolic-ref -q HEAD` 失败 → 拒 `worktree_detached_head`（create 步骤 3 同款）——merge 到 detached HEAD 的 commits 无 ref，checkout 走即悬空、「合并成功却不让清理」；
- **合并目标语义如实（R4b）**：merge 目标是主仓**当前检出分支**——合并确认层显示「将合并到当前分支 `<current>`」（数据源 git/branches current，现成）；主仓检出非默认分支是多会话常态，动作名「合并回主仓」不得暗示固定目标；
- 执行：主仓 cwd `git merge --no-ff <branch>`——与 GIT-INTERACTION-REDESIGN D2'「试探式、不做完整冲突助手」同一哲学（agent 自己会处理冲突细节；GUI 不做 merge 助手）；
- **受 branchSwitchLocked 同锁域**（merge 改写主仓工作树基线，与 checkout 同拆台面——锁判定既有函数复用，含运行中子代理计数）；锁定 → 拒 `worktree_in_use`（message 带运行中会话数）；
- 冲突（merge 失败）：git 原生失败面透传 `conflict_files`（既有错误码复用——checkout 同款解析），**不自动 abort**：冲突现场保留给主仓会话的 agent 接手（「让 agent 解决冲突」是自然工作流）或用户手动；确认框/错误文案指路「在主仓会话让 agent 完成合并或中止（git merge --abort）」；
- 主仓脏（tracked 改动会被 merge 覆盖）→ git 原生拒绝（would be overwritten → `conflict_files`/`dirty_worktree` 既有码）；
- merge 成功 → 分支已收编 → 「清理」门放行 merged 面——但树内残留内容仍会卡 clean 门（R5）：clean 拒的 message 用三类计数通用句「树内有未纳入分支的内容（N 处改动 / M 个未跟踪 / K 个忽略），请在树会话处理或提交后重试」（R3 无强删后门红线不变）；
- **worktree_in_use 码双义纪律（R6）**：merge 锁拒（主仓有运行会话）与 remove 占用拒（树被占用）共用码——两类 message 文案不得互引对方指引（「关闭会话后可清理」不得出现在 merge 拒上）；
- **不删远端/不 push**（push/PR 仍归 agent 与用户，§2 既有边界不变）。

**不处理（归属）**：

- 会话中途换 cwd（thread/rebind）——R2 不做；
- 子代理树通告——整族不做（§1.3）；子代理树生命周期——delegation 既有领地，agent-delegation 包零改动；
- 树内分支再切换——既有 `git/checkout` 在树 cwd 天然工作；
- 主仓 checkout 遇被占用分支——既有 `branch_in_other_worktree` 闭环；
- branchSwitchLocked——语义不变（worktree add 不受锁）；
- 跨仓/multi-root；UI 强删；用户树远端 push/PR 流——agent 自己会提交。
- **fork-to-worktree（携带会话上下文进树）——另案落档**（二轮产品 P6：真实需求「会话进行到一半发现该隔离做」存在，fork 协议扩展独立于本方案；「前往」UI 文案明示预期「将新建会话，不携带本会话上下文」）。
- 树内变更 diff 审查面——占用行/chip 不做「查看变更」入口（pulse 面板打开树 cwd 即可看；落档不做——二轮产品 P9）。

## 3. 并发/一致性预算

- create/remove/merge 在 agent-app 主进程内全局串行（checkoutTail 尾链模式；merge 同改写主仓工作树——与 checkout 并行撞 index.lock，串行收口）；
- **跨进程互斥（复查 N2/C/N5 钉死 + 终审交互 N4 锁锚归一 + 二轮架构 #11 术语分名）**：复刻 x-harness repo lockfile **完整规格**——**锁获取时点：remove 步骤 2（占用门）起、步骤 6（删分支）止，一个临界区**；锁目录**物理钉死在 `<repoParent>/.x-harness-worktrees/repo-<hash(lockKey)>.lock`**（子代理区内；sweep 的 `repo-*.lock` 过滤已兼容 worktree.ts:241）；**lockKey（≠repoTop——第一步产物是 remove git 锚，第二步产物是锁键，分名防混）**：**锁键 repoTop 推导两步**（终审交互 N4：remove 的 cwd 可能是树内目录——会话卡清理入口天然以树路径为 cwd，此时 `--show-toplevel` 返回树自身，锁键错仓与 x-harness 不互斥，TOCTOU 窗口恰在数据安全门路径上 reopen）：第一步 `--git-common-dir` 归一到主仓 repoTop（与 D10 同口径），第二步对主仓目录取 `--show-toplevel` 原样输出作锁键（实测 R：cwd=用户树时 `--show-toplevel` 返回树自身——hash 与父目录双漂移、与 x-harness 天然主仓锚互斥失效；归一后两侧字符串必然一致）；**获取协议整套语义复刻**（mkdir 原子占位 + pid 存活探测 + 30s 创建窗口 + stale 抢占 + 60s 有界等待后降级直跑 + 降级回调）；**双仓锁兼容测试**（含「树内 cwd 与主仓 cwd 取到同一锁键」用例）；互斥覆盖面如实落档：x-harness 嵌套 delegation（worktree 内再 spawn）的锁锚是父 worktree 而非主仓——该形态与 agent-app 并发窗口存在，接受（git ref 事务兜底）；
- **TOCTOU 闭合（二轮数据 P0-2 升级）**：门评估与删除同临界区（锁内，互斥同持锁写者）+ **删分支 CAS（update-ref -d 带门评估时刻 pinned-tip）**——锁外写者（agent bash commit 不持锁）在门后新 commit 使 tip 漂移 → CAS 必败 → 分支保留可恢复；安全性不再依赖锁覆盖面（锁只互斥写者序列，CAS 保数据事实）；detached 树以 remove 前锁内 HEAD 重读比对同语义；
- sweep 不改（一审 P4：既有两道名字过滤 + 独立区结构性隔离）；残余暴露面（同目录 `<repo>-agent-*` 自造形态）落档；
- `git/worktree/list` 纯读无锁；
- thread/notify 入 OBSERVER_COMMANDS。

## 4. 拆分与依赖方向

```
x-harness apps/host-hub/src/protocol/internal.ts   ← THREAD_SCOPED + live-only 谓词（序：表项查找后、retiring requeue 前）+ OBSERVER
x-harness apps/host-hub/src/protocol/commands.ts   ← 词表登记
x-harness apps/host-hub/src/host/worker-pool.ts    ← routeLine live-only 分支
x-harness apps/host-hub/src/worker/worker-commands.ts ← thread/notify 分派（target 单点判定：status() running→notify next-step / idle→next-turn 入队 / 结算边界丢弃应答成功）
x-harness packages/agent-loop/src                   ← 六项落点全集（§1.3）：notify 签名扩 target（types.ts:39/driver.ts:361/plugin.ts:116）+ claimTurnBatch 前导 origin 合并领取 + chainsNextTurn 两队列析取判定 + **step.ts reinsertClaimed 整批回灌 + repair.ts claimReinserts 按 insert target 分组 + driver.ts:265 replay 谓词含非 origin 判定** + insertData 导出面（二轮架构 #1/#2/#3 + 复查遗留 4）
x-harness docs/AGENT-MESSAGE.md                     ← 来源表 +1 行 + §2 API 表/§4 场景 C 随 target 参数同步更新
x-harness docs/PLUGIN-AUTHORING.md                  ← 已知来源表 +1 行（二轮架构 #10）
x-harness packages/agent-delegation/src/__test__    ← 共享测试向量文件（§1.4 双仓各持——§6「零改动」指产品代码，测试向量另计）
agent-app packages/contracts/src/hub-commands.ts    ← HubCommand 镜像（同批同步）
agent-app packages/contracts/src/commands.ts        ← PaiCommandType + PAI_COMMAND_TYPES + 断言测试
agent-app packages/api/src/commands/thread.ts       ← HubApi.thread.notify
agent-app packages/contracts/src/api.ts             ← verb ×4 schema（merge schema 并入 §1.1 代码块统一——二轮产品复查 R2）
agent-app packages/contracts/src/git-views.ts       ← WorktreeEntryViewSchema + 六新码 + locked 字段（见下）+ GitWorktreeRefSchema.branch 改 nullable（detached 行数据面）
agent-app packages/api/src/verbs/git-branches.ts    ← parseWorktreeRefs 适配 detached（branch 缺席收 null）
agent-app packages/api/src/verbs/git-worktree.ts    ← 新文件（create/list/remove 预检链/条件兜底/门/锁复刻/get_subagents 占用探测 + merge 预检双门/--no-ff/冲突面 conflict_files 复用）
agent-app packages/api/src/verbs/local.ts           ← isKnownCwd 接 userWorktreeDirs
agent-app apps/electron main                       ← api-routes + userWorktreeDirs 持久化 + busy 通告投递（含 sourceThreadId 定格接线）
agent-app apps/electron 渲染                        ← 开关/会话内建树/前往/清理确认/i18n 双语
agent-app ui/ui-store.ts                            ← openNewTask 扩 sourceThreadId 字段（来源定格）
agent-app docs/GIT-INTERACTION-REDESIGN.md          ← 关联裁决补记
```

依赖方向全部既有。x-harness 侧改动 = **host-hub 协议四文件 + agent-loop notify/领取面 + 文档两份 + 委派测试向量**（二轮架构 #3 口径修正）；agent-delegation 产品代码零改动（测试向量文件新增不在此约束内）。

## 5. 方向性裁决

| # | 裁决 | 依据 |
| --- | --- | --- |
| D1 | 切换 = 通告（busy 即时注入 / idle next-turn 排队），不是会话迁移 | 用户裁决 R1 + 一审 #2 + 复查 A + 终审交互 N2 |
| D2 | 三入口分工：新建页开关（会话出生在树里）/ 会话内建树（会话在主仓、工作去树里）/ 前往（人进树开新上下文） | 用户裁决 + 复查 A 补全 |
| D3 | 用户树独立区 `.x-harness-user-worktrees/<repo>-<encoded(branch)>`；编码：`/`→`-`、拒前导 `-` 与 `..` 段、existsSync 冲突探测；**Windows 保留字符平台支持面落档**（复查 N8：`isValidBranchName` 放行 `<>|"` 等 git 合法字符，若目标含 Windows 需扩编码或收紧字符集——首期平台面 = macOS/Linux，落档） | 一审 F3/P6 + 复审 |
| D3' | `[wt]` 徽标判据 = cwd 含 `.x-harness-worktrees/` 或 `.x-harness-user-worktrees/` 目录段（两目录名，非路径段数）；消费面三处：runtime 副行（既有正则扩）、composer 项目段徽标、侧栏项目组 | 配套 D3 + 二轮产品 P2 |
| D4 | 数据安全意图同源、判据按域分治（§1.4）；防漂移 = 共享测试向量 | 一审 F4/F7 |
| D5 | thread/notify 通用命令保留（live-only 谓词：未命中/retiring/**spawning 表项 state** 拒 + observer + 分派三态 running/idle/结算边界）；首期消费方 git-worktree 通告 + §1.7 占用门配套 | 用户裁决（§0.2 最优优先）+ 复查 A/N3 交互组 + 二轮架构复查 |
| D6 | 用户树永不自动清理；sweep 落档不改 | 用户裁决 + 一审 P4 |
| D7 | remove 键 = {cwd, path} | 复查 N3 |
| D8 | 删分支 = **CAS `git update-ref -d refs/heads/<branch> <门评估时刻 pinned-tip>`**（exit 0 成功；非 0 → show-ref 复核：缺席幂等成功 / 在场 tip 漂移失败——实测 mismatch 与 missing 同 exit 1，命令行式不可凭 exit 码区分）；**全方案删分支单轨 = CAS，`branch -D` 彻底退役**（含 create 半建兜底）；plumbing 无 checked-out 保护由步骤 2 占用门 + 步骤 5 remove 先行承担 | 复查 N2 + 二轮数据 P0-2/复查断点实测改判（v4.8 修正） |
| D9 | 子代理树通告整族不做 | 一审 P3 |
| D10 | repoTop 口径（remove git 锚与锁键第一步）= `--git-common-dir` → resolve(cwd, out) → dirname → realpath（相对串先 resolve）；**锁键第二步 = 对主仓目录取 `--show-toplevel` 原样输出**（树内 cwd 先归一到主仓再取锁键——终审交互 N4：防会话卡入口锁锚错仓） | 一审 F9 + 复查 N2(c)/N6 + 终审 N4 |
| D11 | 白名单独立集合 userWorktreeDirs + 持久化（不进 pickedRoots 信任面） | 复查 #1/E |
| D12 | live 占用门数据源 = 冷路径：thread/list（cwd，覆盖 live+parked）+ 逐 live 线程 get_subagents（PARKED_DIRECT 成员）；缺席 fail-closed 按占用处理；不进 thread/list 热路径（终审 V2 改判——轮询命令不做 fan-out） | 终审 V2/V4 |
| D13 | 来源会话判定 = 打开新建页时刻 activeThreadId 定格（sourceThreadId）；非 newTaskCwd 判定；idle 会话通告投 next-turn 排队不唤醒（零额外 LLM 调用） | 终审交互 N1/N2 |
| D14 | 会话内建树动作挂载面：composer 分支面板（会话页）+ pulse branch-menu（速览，来源 = activeThread）两处；**新建任务页 BranchPanel 不挂**（已有开关，重复入口） | 终审交互 N6 |

## 6. 老代码处置清单

| 代码 | 处置 | 理由 |
| --- | --- | --- |
| x-harness `agent-delegation` 包 | **产品代码零删零改**（测试向量文件新增另计——§1.4 共享向量双仓各持） | 子代理域与本方案正交（核实口径：改动在 host-hub 协议层 + agent-loop notify 面） |
| x-harness `sweepWorktrees` | 不改，残余风险落档 §3 | 一审 P4 |
| agent-app `git/branches` worktrees 占用表 | 保留 + detached 行呈现（branch nullable） | 数据源复用 |
| `branch_in_other_worktree` / `branchSwitchLocked` / `new-task-screen` 主体 / `mapGitFailure` | 保留/纯增量 | 既有语义不变 |
| **结论：无旧路径删除、无兼容层、无双轨；x-harness 改动 = host-hub 协议四文件 + agent-loop notify/领取面 + 文档两份 + 委派测试向量，agent-delegation 产品代码零改动** | | R4 满足 |

## 7. 实施顺序

| 阶段 | 仓 | 内容 | 验收点 |
| --- | --- | --- | --- |
| 1 | x-harness | thread/notify 全链（internal/commands/worker-pool/worker-commands host 路由）+ agent-loop target 队列参数与领取规则（types/driver/plugin/inbox/step/repair 落点见 §1.3/§4）+ agent-app 契约镜像（同批） | live 收到 content；**parked/dead/retiring/spawning 四态 → thread_not_live 且无 wake 副作用**（进程数不变断言）；notify 不重置 idle；结算边界到达的通告零额外 dial；idle 会话 next-turn 排队不唤醒；**next-turn 仅剩 origin + next-step 有 steer → step0 领 steer 通告留队** |
| 2 | agent-app | contracts + verbs（预检链/条件兜底/门/锁复刻/白名单持久化）+ i18n 六新码 | verb 契约测试（判据向量/路径编码表/错误码闭集/**条件兜底不删用户分支**/gone-dir merged 门照评）；双仓锁兼容测试 |
| 3 | agent-app | 新建页开关（状态机）+ 会话内建树 + 前往 + 分支面板三动作（含 merge-back）+ detached 行 + 清理确认框（两级呈现）+ 会话呈现面（[wt] 徽标三消费点正则扩第二目录名（runtime-worker-row.tsx:114）/composer 徽标/侧栏归并 + 派生树 chip）+ **i18n 全量 en/zh（约 32 key ×2，key 级清单随阶段 3 首提交落档——二轮 P7）** | 组件测试（状态机序列/确认流两级呈现条件显示/i18n 按清单逐 key 断言/占用行数据流 list/merge-back 锁域与冲突面/徽标判据三消费点） |
| 4 | agent-app | busy 通告投递（thread/notify 消费方）+ AGENT-MESSAGE 来源登记 | 主进程经 HubApi 投递；busy 会话步边界材料化；idle/新建页（无来源）零注入零调用 |
| 5 | 双仓 | e2e：三入口建树 → start（含失败回滚）→ 前往 → 通告 → **合并回主仓（含树内发起拒/锁拒/冲突面）** → 清理全旅程（非零提交树——零提交树测不出收编链，二轮产品复查 R3） | 既有 e2e 装置扩旅程 |

每阶段末 diff 级对抗审查。

## 8. 测试口径

- **契约**：verb ×4 strict（含 merge 预检双门）；六新码 en/zh 齐套；thread/notify 形状门 + live-only（**parked/dead/retiring/spawning 四态拒**且无 wake）+ observer（idle 不重置）+ running 守卫；
- **判据表驱动（共享向量）**：净/脏 × 已收编/未合并 × merge 头 × detached（含 merge-commit tip 形态——`--no-merges` 公式丢失侧 vs is-ancestor 安全侧双断言）× untracked × **ignored（`!!` 条目——二轮 P0-1）** × `+` 前缀 × prunable × 单分支仓空集（恒拒=保守正确）× squash-merge × cherry-pick × **纯同步 merge 小误拒形态（tree 差 0 断言）** × **目标自身入列（双分支仓 + 未合并 + is-ancestor(b,b) 恒真 + 断言拒——唯一能抓住枚举 bug 的向量）** × **同 tip 异名分支（放行断言——is-ancestor 正确放行面）** × **门命令 exit 三态（0=放行 / 1=继续探测下一分支 / ≥2=fail-closed）** × **子模块内改动（现状行为断言——防线缺口如实锚定）**——双仓各持（is-ancestor 化后 `--not` 拼装类向量随判据更换退役）；
- **路径编码表**：`feat/login`→`feat-login`、前导 `-` 拒、`..` 拒、大小写撞拒、跨仓撞拒、同仓异分支同编码拒；
- **create 预检链序**：每步独立用例；**分支已存在失败路 → 兜底零执行**（回归名「半建兜底不得删用户既有分支」）；**半建三形态回收**（二轮 P1-7）：used-by-worktree → prune 重试后分支清；本轮半建目录 → 递归回收；**add 半途中途死 → 重试 create 同分支必须成功**（回归名「双门锁死」）；
- **remove 时序**：gone-dir → merged 门照评（未合并 → 拒，数据保留）；live 占用（会话 cwd 前缀 / 子代理 get_subagents 路径命中）→ 拒；**锁外写者穿插（二轮 P0-2 全链复现）**：门评估（tip pin）→ 锁外 commit → remove 成功 → CAS 非 0 → show-ref 复核在场 → 报错 → 断言分支保留且新提交可达（回归名「锁外 commit 不随树丢失」）；**CAS 幂等**：分支已被并发删 → 非 0 → 复核缺席 → 幂等成功不谎报；**detached 树 HEAD 重读比对**：门后树内 commit → remove 前比对失败拒；**ignored 文件在场 → 拒**（回归名「被忽略文件不随树静默删除」）；**broken .git → status 失败 fail-closed + prune 指路**；
- **锁兼容**：双仓互斥（同锁路径串行，含**树内 cwd 与主仓 cwd 同锁键**用例）；crash 残留 → 窗口后接管；
- **通告**：busy 发起/来源会话恰一条 content、材料化 user 投影含模板要素、serialize 保留；
- **领取规则三缺陷防线（二轮架构复查）**：blocked 步回灌不丢用户消息（step0 领取批含前导 origins + 用户消息 → preStep 拒 → 整批回插断言）；WAL 修复不错靶（混合批崩溃 → 按 insert target 回灌断言 steer 仍走步边界）；replay 不空 kick（仅剩 origin + wakeRequested → 无 turn 括号断言）；前导 origin 上界（9 条排队 → 领 8、余 1 留队下轮领取，零丢失断言 + 批末计数行）；**idle 会话 next-turn 排队不唤醒**（下条消息步边界材料化、零额外 dial）；无来源/前往/清理零注入零 dial；queueMirror 对带 origin 条目的投影形态（不显示为用户转向卡片——实施时验证，若需 UI 过滤落 §1.5 增量）；
- **UI**：状态机序列（空 cwd/selectCwd 重置/loading/failed 文案/树内禁用/锁态可用）；会话内建树流；前往预填不替换；确认框数据流（list 取数）与 squash 口径句；detached 行清理可达；
- **原子性**：create 成功 + start 失败 → 渲染层回滚（回归名「start 失败自动回滚」）+ 崩溃窗口残留落档（双入口兜底断言）；
- **越权矩阵**：remove 对运行中子代理树（get_subagents 路径命中）→ 拒；live 会话树 → 拒；get_subagents 应答缺席 → fail-closed 拒；verb 不设区门但占用门先行；白名单不含 pickedRoots 面（信任面断言）；白名单 GC（remove 后条目消失、启动过滤陈旧）；
- **merge-back**（二轮 P1）：主仓锁态 → 拒 worktree_in_use 带会话数；**树内 cwd → 拒 worktree_nested（含另一棵树/树子目录形态）；主仓 detached → 拒 worktree_detached_head**（预检双门独立用例，二轮产品 N4）；冲突 → conflict_files 透传且**不自动 abort**（现场保留断言）；成功 → remove 门 merged=true 放行（建树→工作→合并→清理全链 e2e，非零提交树）；主仓脏 → 既有 dirty/conflict 码；
- **通告内容效力**（二轮 P3）：材料化投影含树路径与分支名与「勿改主仓」语义（模板断言，非仅「恰一条」）。

## 9. 验收清单

- [ ] 契约 1.1–2.1 逐条（verb ×4 含 merge-back/预检链/条件兜底/gone-dir 门、notify live-only 全链、通告投递面与 text 模板、白名单、占用门、会话呈现面）
- [ ] §2 不处理清单逐条归属
- [ ] §3 并发预算：锁完整规格复刻 + 双仓兼容测试；TOCTOU 残余落档
- [ ] §6 核实：agent-delegation 产品代码零改动（测试向量另计）；host-hub 协议四文件 + agent-loop notify/领取面 + 文档两份
- [ ] 四门两仓全绿 + 覆盖率不降（如实报告）
- [ ] e2e 旅程绿
- [ ] 第一轮初审 + 复查全部清零；第二轮审查清零

## 10. 审查记录

### 第一轮初审（35 项）处置：全部接受（详见 v2 §10，此处不重复）。

### 第一轮复查（三视角，24 项新发现 + 12 项残留判定）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 交互 A + 架构 N3（两视角独立命中） | thread/notify 死通道 | **接受（用户裁决方向）**：保留整族 + 补会话内建树入口 + 来源会话投递（§1.3 表、D2/D5）；裁决原则落档 §0.2 |
| 交互 B + git N2 | gone-dir 跳门 + `-D` 逃生口；`-d` 语义错位 | **接受**：gone-dir 只免 clean 门、merged 门无条件（§1.1 步骤 3/4）；删分支定 `branch -D` + 锁内门原子性（D8 改判，附实测依据）；§1.4 边界描述按真实行为改写 |
| git N1 | 无条件半建兜底删用户分支 | **接受**：分支存在预检（步骤 2）+ 条件兜底（rev-parse == 起点才删）（§1.1） |
| git N3 / 交互 #1+E | remove 缺 cwd；白名单重启残留 + 信任面 | **接受**：参数 {cwd,path}（D7）；userWorktreeDirs 独立集合 + 持久化（D11/§1.6） |
| 架构 N1 | retiring 态未定义 | **接受**：retiring 视同 not-live 拒（§1.2） |
| 架构 N2 + 交互 C + git N5（三视角独立命中锁缺口） | 锁键/位置/算法规格 | **接受**：§3 完整规格钉死（子代理区物理位置/原样口径锁键/整套获取协议/兼容测试/嵌套锁锚覆盖面落档） |
| 架构 N4/F + 交互 F | 「x-harness 零改动」表述矛盾 + typo | **接受**：改「agent-delegation 零改动；host-hub 四文件 + AGENT-MESSAGE 文档」；typo 修 |
| 交互 D + git（list 消费） | 确认框数据源缺失 / list 零消费 | **接受**：确认框数据流 = list（§1.5） |
| 交互 G | 结算边界竞态 | **接受**：worker running 守卫 + 用例（§1.2/§8） |
| 交互 #4 残留 | detached 树无清理入口 | **接受**：占用表 detached 行（§1.5） |
| 交互 #5 残留 | failed 态文案 | **接受**：§1.5 状态机补 |
| 交互 #10 | 渲染层回滚崩溃窗口 | **接受（落档）**：不声称「不留孤儿树」；双入口兜底 |
| git N4 | §1.4 边界描述失真 | **接受**：按实测行为改写（无 `-d` 拒绝态叙事） |
| git N6 | D10 相对串 resolve 顺序 | **接受**：D10 补顺序（先 resolve 再 dirname 再 realpath） |
| git N7 | squash/cherry-pick 文案误导 | **接受**：确认框口径句 + 向量补形态 |
| git N8 | Windows 保留字符 | **接受（落档）**：平台面首期 macOS/Linux（D3） |
| git N9 | create 树内门 verb 侧缺 | **接受**：步骤 5 `worktree_nested`（§1.1） |
| git N10 + 交互 #9（两视角） | 占用门数据源 | **接受（两轮改判）**：终审改冷路径 get_subagents（PARKED_DIRECT 成员，逐 live 线程）+ fail-closed + 覆盖 live+parked（D12/§1.7） |
| 架构 P5 残留 | 锁与 D10 边界 | **接受**：D10 两口径分界钉死（§3/D10） |
| 架构 (a) | live-only 接入顺序 | **接受**：§1.2 判定顺序条款 |
| 架构 P2 nit / 交互 #3 nit | 「同提交」跨仓不可行 | **接受**：改「同批同步落地」 |
| 交互 #2(b) | busy 零调用非不变量 | **接受**：running 守卫（同 G） |
| git F7 建议 | 向量补两条 | **接受**：`branch -d` 拒绝态不再适用（D8 改判）；单分支仓空集已补 |

### 第一轮终审复查（架构 V1–V4 / 交互 N1–N6+S 系 / git X1/X2/W/S2/U2/T2）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 架构 V1 + 交互 N1（同根） | 来源会话身份：cwd 反查漂移 / 判定键与代码事实错位（四调用点全传 ''，defaultCwd 回退） | **接受**：sourceThreadId 打开时定格 + 「enterCwd 为空→无来源」分类废弃（D13/§1.3） |
| 架构 V2 | worktreePaths 进热路径 + fail-open | **接受**：改判冷路径 get_subagents（PARKED_DIRECT）+ fail-closed + live+parked 覆盖（D12/§1.7） |
| 架构 V3 | R4 措辞滞后 | **接受**：四文件口径统一 |
| 架构 V4 | 占用门漏 parked；gone-dir+detached 形态 | **接受**：门覆盖 live+parked；该形态 fail-closed 拒（§1.7） |
| 交互 N2/N3/S1 | idle 会话建树无策略；busy 判定时序无反馈；成功反馈未定义 | **接受**：idle 投 next-turn 排队不唤醒（零额外调用）；建树成功 UI 反馈含「空闲时下条消息生效」（§1.3/D13） |
| 交互 N4 | 锁锚在树内 cwd 漂移错仓（会话卡入口击穿互斥） | **接受**：锁键两步推导（common-dir 归一主仓 → 主仓 toplevel 原样）+ 同锁键用例（§3/D10） |
| 交互 N6 | 动作挂载面未裁决 | **接受**：composer + pulse 两处，新建页不挂（D14） |
| 交互 #4 契约缺口 | GitWorktreeRefSchema.branch 非空与 detached 行矛盾 | **接受**：branch 改 nullable + parseWorktreeRefs 适配（§4 拆分行补录） |
| 交互 S2/S3 | 空集语义显式化；白名单 GC | **接受**：恒拒=保守正确断言（§8）；remove 顺带清理 + 启动过滤（§1.6） |

### 第二轮审查（三全新视角：产品 P1–P10 / 数据安全 / 架构协议——在途两项）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 产品 P1（阻断） | 生命周期缺「收编」：清理门要求 merged 但方案无 merge 动作——用户最有价值的工作恰是清理门永久拒绝的对象 | **接受（完整档）**：新 verb `git/worktree/merge`（merge --no-ff + branchSwitchLocked 锁域 + 冲突 git 原生面不自动 abort + 指路 agent 接手）+ 分支面板第三动作 + e2e 闭环（§2.1/§1.5） |
| 产品 P2 | worktree 会话呈现面无定义；[wt] 徽标只活在管理页；侧栏密文新组 | **接受**：呈现面三处钉死（composer 徽标/侧栏并入主仓组（组键=repoTop）/runtime 正则扩）；D3' 措辞消歧（§1.5/D3'） |
| 产品 P3 | 通告 text 无模板——入口价值押在没写的文案上 | **接受**：模板钉死（树路径/分支/工作根指引/勿改主仓语义）+ §8 内容效力断言（§1.3） |
| 产品 P4 | 会话卡清理入口被自身会话占用恒拒且无指引 | **接受**：in_use message 带占用名单 + 「关闭会话后可清理」指引（§1.5） |
| 产品 P5 | 显示与实际工作区长期分离只有一次性 toast；反馈句未按入口分支 | **接受**：threadId→树路径登记 + composer 持久「派生树」chip（前往/清理）；反馈按入口分句（§1.3/§1.5） |
| 产品 P6 | fork-to-worktree 需求从需求地图消失 | **接受（另案落档）**：§2 补行 + 前往文案预期管理 |
| 产品 P7 | i18n 体量未盘点（约 30 key ×2） | **接受**：阶段 3 明列 i18n 全量 + key 级清单随首提交 + §8 逐 key 断言（§7） |
| 产品 P8 | 确认框被多轮修补叠加成 git 专家审查面板 | **接受**：两级呈现（主句后果+数量/详情折叠条件显示）+ 文案人话化（§1.5） |
| 产品 P9/P10 | diff 审查面；前往落地页开关禁用突兀 | **接受**：P9 落档不做（pulse 面板覆盖）；P10 正向指引文案（§1.5/§2） |

| 架构组终审立场 | thread/notify 保留 | **认可**（独立判断非顺从：v3 补真实消费方后保留是更优架构）；同时提醒 §0.2 原则不可滥用（「暂无消费者不砍」限通道语义薄 + 首期有消费方 + 后续需求同类） |

### 第二轮架构组二次验收（v4.4：通过，附 4 应修 + 4 建议——已全部核销）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 架构二验 1 | §1.1 步骤 7 主语残留 branch -D（与 D8 单轨矛盾） | **核销**：改「删分支失败（CAS tip 不匹配/反查失败）」 |
| 架构二验 2 | §4 agent-loop 行漏三消费方（step/repair/replay） | **核销**：六项落点全集入 §4 |
| 架构二验 3 | 领取规则未声明 next-step 侧不变——steer 搁浅读法歧义 | **核销**：规则句补「仅约束 next-turn 侧 + next-step 全领不变 + 不链式两队列析取」+ 阶段 1 验收补 steer 用例 |
| 架构二验 4 | live-only 用例漏 spawning（规范有测试无） | **核销**：§7/§8 补 spawning 四态 |
| 架构二验建议 ×4 | D5 简表滞后；上界「丢弃最旧」改留队列零丢失（采纳——content 丢最旧=丢事实）；live 重估时点；slot 态措辞 | **核销**：D5 三态口径 + 上界改「留队列下轮领取 + 批末计数行」+ 同点重估明文 + 「表项 state」数据源措辞 |
| 架构组二验立场 | —— | **通过（无需架构回炉、不必再开全量审查）**；「落档后 grep 校验固定为批量修改收尾步」采纳为流程纪律 |

### 第二轮数据组轻量确认（v4.6→v4.8：一处规格修正闭合）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 数据组确认 1 | exit 三态矩阵与命令形状不匹配（命令行式 mismatch/missing 同 exit 1；主会话上轮实测 128 系坏实验——拼入非法 sha 的参数校验错，非 mismatch 语义） | **接受 + 双向纠错落档**：改「exit 两态 + show-ref --verify 复核在场性」（复核与 create 步骤 2 预检同款零新面）；create 兜底/D8/§8 三处同步；实验教训入档（实测须用真实存在的 sha 构造 mismatch） |
| 数据组确认 2 | 断点一/三 + 盲向量/F2/F3 | **确认通过**（其验收原文） |
| 数据组终审立场 | —— | **通过（规格级单点修正完毕，可直接进实施）** |

### 架构组核销后追加（grep 校验流程自证：两处文字级残留）

| 来源 | 问题 | 处置 |
| --- | --- | --- |
| 架构组核销验证 | 步骤 7 残留「exit 1 幂等成功（见三态判别）」——引用已废的三态口径 | **核销**：改「复核缺席 = 幂等成功」（两态+复核口径统一） |
| 架构组核销验证 | §8 上界用例残留「最旧丢」——与 §1.3「留队零丢失」矛盾（按 §8 写用例会断言出相反行为） | **核销**：改「领 8 余 1 留队 + 零丢失断言 + 批末计数行」 |
| 架构组核销验证 | is-ancestor 门「128=fail-closed」表述——128 是通用致命错非专用码 | **核销**：统一「≥2」口径（§1.1/§8 两处）；架构组与数据组的 exit 矩阵实测至此三方一致（0 成功 / 1 歧义→show-ref 复核或继续探测 / ≥2 致命） |

### 数据组终验（v4.8：确认通过——双向纠错闭环）

| 来源 | 结论 | 处置 |
| --- | --- | --- |
| 数据组终验 | 坏实验根因三方复现一致（A1 非法串参数校验 128 / A2-A3 mismatch 同 1）；四处落档核对到位；修法链路实测走通（CAS 0 成功 / 1+复核在场=漂移 / 1+复核缺席=幂等） | **确认通过，数据组闭环，遗留归零**——CAS 链、is-ancestor 门、clean 门、半建兜底、幂等纪律全部经实测压过且方案文本与实测行为一致 |

**未接受项：无**。初审 35 + 复查 24 全部处置。
