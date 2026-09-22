# SANDBOX：@x-harness/sandbox（srt 围栏执行环境）

> 状态：定稿（2026-09-23；用户裁决三条 + 默认裁决否决窗口）
> 级别：中（单新包替换旧包 + 引擎更换 + 权限解耦；插件对外面不变，harness 接线换包）
> 取代 docs/EXEC-ENV.md §4 的 sandbox-local 实现（该节保留为历史设计记录；本文件描述当前行为）。

## 0. 裁决

**用户裁决（2026-09-23）**：
1. **旧 `packages/sandbox-local` 整体废弃**——full 档网络被拒 + bash 执行失败，完全不可用；不参考不复制，直接删除。
2. **sandbox 只实现围栏（sandbox），不实现权限**——一切裁决/授权/broker ask 归 `packages/permission`（本件不动 permission 任何行为）。sandbox 仅消费 permission 的 grants **数据面**（extraRoots / domains / unrestricted / rootOverride 事实）合成围栏。
3. **引擎 = `@anthropic-ai/sandbox-runtime`（srt）**：OS 级围栏（darwin seatbelt / linux bwrap / win WFP）+ 域名白名单代理，库形态嵌入。

**默认裁决（否决窗口）**：
- 新包名 `@x-harness/sandbox`（目录 `packages/sandbox`）；插件名 `sandbox`（tool-core softInject 同步换名）。
- `fenceFacts` 服务仍由 sandbox 提供（消费方 permission 定义 token）：提供**事实快照**不是实现权限——决策/规则/ask 全在 permission。缺席 fenceFacts 时 permission bash 界内 auto 退化（既有语义）。
- 网络面 = **纯白名单 strictAllowlist，无 CONNECT 期 ask**（用户裁决②的直接推论：ask 是权限交互，归 permission/宿主）。白名单来源：宿主 `allowedDomains` 配置 ∪ 会话域名授权并集 ∪ unrestricted→`["*"]` 全通。表外域名硬拒（curl 可见 403/连接拒绝）。
- 内核面默认拒读表 = `~/.ssh`、`~/.aws`、`~/.gcp`（具体 `~` 路径形态；与旧语义一致）。`**/.env` 任意深 glob 在 srt 相对模式按**宿主 cwd** 解析、不可靠——`.env` 防护维持工具面（permission DEFAULT_DENY_READ）承载，内核面不表达（延续旧落档）。
- `denyWrite`（受保护路径）默认 = 工作区 `.git`（具体路径）；嵌套 `**/.git/**` glob 在 linux 写面被 srt 剥除（darwin 可用）——跨平台一致取具体路径，嵌套 .git 落档工具面承载。
- 子进程 env 密钥清洗保留（`KEY|PASSWORD|SECRET|TOKEN` 键名过滤，纯函数）；srt credentials 面不接入（§不处理）。

## 1. 外部契约

```ts
// packages/sandbox（@x-harness/sandbox）
export interface SandboxOptions {
  readonly root: string;                    // 工作区根
  readonly writableExtra?: readonly string[];  // 宿主附加可写（realpath/词法 resolve）
  readonly denyReadExtra?: readonly string[];  // 内核拒读附加（绝对或 ~/ 前缀）
  readonly protectedPaths?: readonly string[]; // denyWrite 附加
  readonly allowedDomains?: readonly string[]; // 宿主预授权域名（永不 ask——无 ask 面）
  readonly networkOff?: boolean;            // true=网络全断（白名单恒空、不并入授权）
}

export function createSandboxPlugin(options: SandboxOptions): Plugin;
// Plugin { name: "sandbox", inject: ["permission"] }
// provides: execEnv（围栏版——fs 面直通 base，spawn 面经 srt 包裹）
//           fenceFacts（同一解析函数产物——permission 界内判定消费）
```

- **fs 面直通**：`realpath/stat/openRead/writeFileAtomic/readDir` 委托 base（`createLocalEnv`）——
  fs 执法在 gate/permission（EXEC-ENV §3 裁决不变）；sandbox 只管 spawn 面。
- **spawn 面**：`argv` → `exec <shell-quote argv>` 命令文本 → `SandboxManager.wrapWithSandboxArgv`
  → base.spawn(wrapped.argv, scrubEnv(env))。srt 返回的 env **不采用**（macOS/Linux 下为宿主
  process.env——未清洗）；srt 的代理/TMPDIR 注入经 wrapped 命令内 `env` 前缀自带，叠加在我们
  传入的清洗 env 之上。
- **拆卸契约（时序）**：`tornDown` 置位（新 spawn fail-fast `sandbox_unavailable`）→ 活句柄两段杀
  （term → 5s 宽限 kill）→ `await settled`（有界 5s）→ srt `reset()`（停代理/清理）→ 释放进程
  单例占用 → off()。拆卸窗口逃逸复查：spawn 返回时已 tornDown → 立即自杀不交还调用方。
- **错误形态**：spawn 失败 `{ ok: false, reason: { kind: "sandbox_unavailable" | "io_error" | …, detail } }`
  （沿用 ExecEnv 判别联合）；装配期依赖缺失/单例冲突 = apply throw（fail-closed 拒启）。

## 2. 问题域

**处理**：spawn 面内核围栏（读/写/网络三面）；围栏事实快照（fenceFacts）；拆卸生命周期；
env 密钥清洗；srt 单例生命周期管理。

**不处理（归属）**：
- 权限裁决/规则/授权写入/broker ask——`packages/permission`（用户裁决②）。
- fs 面执法（denyRead/protectedPaths/根围栏对 read/write/grep 工具）——gate/permission 进程内单点。
- 域名授权的**产生**（谁批域名）——permission grants（宿主/规则写入）；sandbox 只读并集。
- `.env` 与嵌套 `.git` 的内核面表达——工具面承载（§0 默认裁决）。
- TLS 终结/凭据注入/srt credentials 面、MITM——不接入（EXEC-ENV §9 延续）。
- Windows——POSIX-only（srt 有 win 面但本仓 ExecEnv/local spawn 不支持）。
- unrestricted 进程级总括下 **worktree（rootOverride）会话的网络隔离**——srt 单代理无连接归属，
  全局 `["*"]` 期间 worktree 子进程网络同被放开（fs 面隔离不变）。旧 per-session 代理口的隔离
  能力随引擎更换失去，落档为已知边界（fs 隔离完整保留；full+worktree 并发是罕见形态）。
- macOS setsid 孙进程宿主退出残留（无 PDEATHSIG 等价）——旧落档延续，srt 同边界。

## 3. srt 映射

**围栏合成（纯函数，session 键控）**：

```ts
interface Fence {
  readonly writable: readonly string[];      // → allowWrite
  readonly denyRead: readonly string[];      // → denyRead（~/ 与绝对路径形态）
  readonly denyWrite: readonly string[];     // → denyWrite（protectedPaths）
  readonly allowedDomains: readonly string[]; // fenceFacts/全局并集原料
}
```

`fenceFor(options, grants, session)`：
- `writable` = [root（override 会话→override.dir）, tmpdir(), …writableExtra, …extraRoots
  （override 会话滤除 guard 子树内批准）]；`grants.isUnrestricted(session)` → 前置 `"/"`
  （总括吸收一切；override 会话 isUnrestricted 恒 false——件13 防打穿）。
- `denyRead` = [~/.ssh, ~/.aws, ~/.gcp] ∪ denyReadExtra（full 档不豁免——用户裁决②底线表）。
- `denyWrite` = [root 的 .git] ∪ protectedPaths（同上不豁免）。
- `allowedDomains` = networkOff ? [] : ([…allowedDomains 配置, …grants.allowedDomainsOf(session)]；
  isUnrestricted → `["*"]`)。

**文件面（per-exec）**：每次 spawn 以 `customConfig.filesystem = { denyRead, allowWrite, denyWrite }`
整体传入（srt 语义：per-call 字段级 ?? 回退——传全量防会话级残值混入）；linux glob 写面被剥、
darwin 原生 glob（我们只传具体路径，无跨平台分歧）。

**网络面（进程级 + live-swap）**：启动恒带 `network: { allowedDomains: [], deniedDomains: [],
strictAllowlist: true }`（= 围栏恒在，空表=全断）；**无 ask 回调**。每次 spawn 前重算白名单
= 各活实例有效表并集（实例内：networkOff ? [] : 宿主 allowedDomains ∪ 该实例已见会话授权域名；
grants unrestricted 态 → `["*"]`），与当前生效集 diff 有变才 `updateConfig`（srt 语义：网络配置
每请求热读——授权对在跑子进程的下一次连接即时生效；授权即时生效通道，probe 实证）。

**生命周期（进程共享 + 引用计数）**：srt `SandboxManager` 是模块级单例，而一个进程并行装配
多个世界（测试生态/host-hub worker）是常态——多插件实例经 `srt-session` 共享点共用唯一 srt
会话（按 runtime 实例 WeakMap 键控）：首个 attach 探测依赖 + 以**最紧空集基线**启动（文件面真值
恒随 per-exec fence 走，基线 fail-closed）；末个 detach 才 `reset()`；中间退出只收缩白名单。
网络白名单取**跨实例并集**（与跨会话并集同边界：srt 单代理无连接归属——进程级白名单语义，
落档已知边界；共享世界/测试生态的多世界形态因此天然支持）。顺序复用（attach→detach→attach）
成立（reset 后换配置再 init，probe 实证）。

**fail-closed**：attach 期 `checkDependenciesAsync()`（darwin seatbelt / linux bwrap）errors 非空 →
throw 拒启；linux 的 denyRead glob 展开需 rg——`Bun.which("rg")` 探测，缺席即依赖错误。
运行期 wrapper 失效 = 子进程非零退出（EPERM/stderr 可见），spawn 面不裸跑。
**拆卸后** srt wrap 调用不再发生（tornDown 先行检查——reset 后 wrap 会产出**无围栏** argv，
probe 实证，绝不可走）。

**commandId 归因**：每次 wrap 传 `commandId = "${session ?? "anon"}:${randomUUID()}"`——
srt 违规记录/调试日志可归因到会话（消费面后续件；现在仅登记）。

## 4. 并发/一致性预算

- 围栏解析纯同步函数，无共享可变态；spawn 期 allowlist 重算 = O(会话×域名) 数组操作，仅在
  集合变化时调 `updateConfig`（同集不触）。
- 活句柄 `Set<ProcHandle>` + settled 自清（同旧）；拆卸两段杀宽限 5s 有界。
- srt 单例占用标志同步置位/释放（apply/dispose 各一次，无竞态窗口）。
- 同会话 bash 排他（fence 会话一致性前置）不变——EXEC-ENV §6 落档延续。

## 5. 测试口径

- **纯函数表驱动**：fenceFor 矩阵（base/extraRoots 并入/override 替换+guard 过滤/unrestricted→
  ["/"]+["*"]/networkOff 空/域并集去重）；shellQuote（空串/空格/单引号/换行/utf-8）；scrubEnv
  （KEY|PASSWORD|SECRET|TOKEN 命中与误伤邻词）；allowlist 并集/diff 计算。
- **插件生命周期**：apply（依赖 ok→claim→init）；依赖缺失 throw（依赖检查注入缝）；并发第二
  apply throw；dispose 后 spawn fail-fast；活句柄两段杀+settled；拆卸窗口逃逸自杀。
- **真内核 e2e（darwin 默认门，wrapper 在场 skip=0 即失败）**：界内写通/越根写 EPERM/拒读
  ~/.ssh EPERM/.git 写拒而同根他处可写/空表网络拒/live-swap 授权后放行（无 re-wrap）/
  unrestricted ["*"] 全通/env 清洗（子进程见不到 SECRET）/组杀与 settled 在 wrapper 下/
  拆卸后 spawn 拒。linux 真内核腿 in-repo 不可达（darwin 开发机）——代码面零平台分支
  （平台差异收敛在 srt 内），known-untested 标注延续。
- **覆盖率**：行/语句/函数 ≥90、分支 ≥85（平台分支不在本包——可达；禁 mock 凑数）。

## 6. 改/删映射与批次

| 文件 | 处置 |
| --- | --- |
| `packages/sandbox-local/**` | **整删**（用户裁决①） |
| `packages/sandbox/**` | **新增**（fence / shell-quote / scrub-env / allowlist / srt-runtime 缝 / env / plugin + __test__） |
| `packages/harness/src/index.ts` | fenceKit 换 `@x-harness/sandbox` |
| `packages/tool-core/src/tool-plugin.ts` | softInject `"sandbox-local"`→`"sandbox"`（注释同改） |
| `packages/permission/src/tokens.ts`、`packages/core/exec-env/src/local/plugin.ts` | 注释里 sandbox-local 提法改指新包 |
| `docs/EXEC-ENV.md` §0/§4 | 指向本文件（历史设计记录保留） |

批次：B1 包骨架 + 纯函数 + 单测；B2 srt-runtime 缝 + 插件生命周期 + spawn 面 + e2e；
B3 接线切换 + 删旧包 + 文档 + 四门 + 对抗审查（独立只读会话审 diff）+ 收口。
