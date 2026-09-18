# EXEC-ENV：执行环境 + 本机沙箱 + auto 权限（件 11）

> 状态：已实施（B0–B4 交付；方案审三路 §11 + 代码审两路 §13 全处置；四门绿；验收 §12）
> 级别：大（三新包 + toolbox 六文件全量异步化改造 + 内核围栏 + 权限规则引擎；无过渡版本，一次交付生产可用）
> 参考思想：argv 改写沙箱与 SANDBOX_UNAVAILABLE fail-closed、host-exit finalizer 前置排序与
> quiescence（deepseek-harness）；双端口 fs/exec、注入缝测试、拒读 glob 与反探测（my-agent）；
> Result 化环境接口（pi）；auto-allow、域名白名单代理、受保护路径、会话级授权（Claude Code）。
> 思想归属逐条标注；不复制代码。

## 0. 形态、装配与裁决

三新包 + 一改造：

```ts
// packages/exec-env（@x-harness/exec-env）——契约 + localEnv 原生实现（无围栏）
export const execEnv = defineService<ExecEnv>("exec-env");

// packages/sandbox-local（@x-harness/sandbox-local）——围栏执行环境 provider
export function createSandboxPlugin(options: SandboxOptions): Plugin;   // inject ["permission"]
// provides: execEnv（围栏版）+ fenceFacts（围栏事实快照，permission 界内判定用；同一解析函数产物）

// packages/permission（@x-harness/permission）——规则引擎 + auto 决策 + broker + 会话授权
export function createPermissionPlugin(options: PermissionOptions): Plugin;  // inject ["tools"]
// provides: permissionGrants（会话授权集）+ permissionBroker（人类裁决，宿主提供）
//         + permissionDecided（审计事件）；on(sessionDisposed) 逐出会话桶

// packages/toolbox 改造：六文件全部经 ExecEnv（spill 例外——宿主侧运维产物，明文豁免）；
// createToolbox 增三级解析：工厂参数 env > ctx.use(execEnv) > 装配期 throw（fail-closed）
```

装配即选择：`[permissionPlugin, sandboxPlugin, toolsPlugin, ...toolboxPlugins]` = 围栏+auto；
不装 sandbox = permission 照常裁决但无围栏（bash 不得界内 auto，见 §6）；只装 localEnvPlugin =
现状等价（工具可用、无围栏无权限）。

**用户裁决（2026-09-19）**：① 网络面 = **域名表白名单**（用户态代理组件，非布尔开关）；② bash 默认
敏感拒读表 = **默认在场、宿主可加不可减**（缩减仅经显式 danger 配置）；③ ask-broker = **服务 token +
缺席退化 deny + e2e 可编程假体**（无宿主 CLI 包，库形态）；④ 权限规则词汇表 = **完整版**（段解析 +
注入检测 + 硬拒底线 + 前缀规则 + 会话授权，对照 my-agent 全量）。

**默认裁决（否决窗口已过）**：平台 darwin(Seatbelt)+linux(bwrap/socat) 双平台；POSIX-only 维持
（TOOLBOX.md §7）；审计事件落 core 事件 token，会话流持久化归属 session 件后续；spill 维持宿主侧；
拒读 glob 深度语义取 my-agent 文档化的 fail-safe 过拒（`/*` 前缀含嵌套）；会话授权只增不减（本件
口径，撤销通道落档后续）；**验收用例基数以收口时 `vitest run` 运行期报告为准**（当前快照：toolbox
66 静态/76 rg 在场运行期，tools 37 静态/59 运行期——静态=源 it 数，运行期=it.each 展开）。

## 1. ExecEnv 契约（packages/exec-env/src/types.ts）

fs 与 proc **对等双面、各自原生实现**（否决「exec 派生 fs」——三仓零先例：远端后端两 seam 均走 SDK
原生）。全判别联合不 throw；错误 reason 为**闭集判别**（非自由文本——错误 TEXT 契约存活才有类型保证）：

```ts
export interface FileVersion { readonly ino: string; readonly size: string; readonly mtimeNs: string } // 全 string：同 env 内可判等即可，序列化安全（wire/审计）
export interface FileStat { readonly kind: "file" | "dir" | "other"; readonly size: number; readonly version: FileVersion }
export type ReadChunk = { ok: true; data: Uint8Array | null } | { ok: false; reason: "io_error" }; // data null=EOF；io_error 绝不折成 EOF（假空比错误危险——TOOLBOX §9 纪律）
export interface ReadHandle { read(): Promise<ReadChunk>; close(): Promise<void> }
export interface DirEntry { readonly name: string; readonly kind: "file" | "dir" | "symlink" | "other" }
export interface ProcHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>; // 信号死亡=code null + signal；128+n 折算属渲染层
  /** 信号投递即 resolve；幂等、已死后调用为 no-op、永不 throw */
  kill(phase: "term" | "kill"): Promise<void>;
  /** 整树（含孙进程与 pidns 内进程）死净后 resolve——「组长退出≠组清空」的观测面；env 内实现 settle 语义 */
  settled: Promise<void>;
}
export interface SpawnRequest {
  readonly argv: readonly string[];   // 逻辑 argv（如 ["/bin/sh","-c",cmd]）；实现自行包裹传输层
  readonly cwd?: string;
  readonly session?: SessionId;       // 围栏解析键；所有 spawn 调用点（含 rg）必须透传 ctx.session
}
export type SpawnFailure = { readonly kind: "not_found" | "not_executable" | "cwd_invalid" | "sandbox_unavailable" | "io_error"; readonly detail: string };
export type SpawnResult = { ok: true; proc: ProcHandle } | { ok: false; reason: SpawnFailure }; // 无句柄即无 exited——spawnError 通道等价保留
export type StatResult = { ok: true; stat: FileStat } | { ok: false; reason: "not_found" | "access_denied" }; // EACCES 不折叠成 not_found——FS_ACCESS_DENIED 语义依赖此分支
export type OpenReadResult =
  | { ok: true; handle: ReadHandle; version: FileVersion }  // version 取自打开的 fd（fstat 原子）——stat/open 竞态窗口（存量缺陷 D2）的根治原语
  | { ok: false; reason: "not_found" | "not_regular" | "access_denied" };
export interface ExecEnv {
  readonly kind: string;
  readonly root: string;                       // env 内工作区根（realpath 归一）
  /** 不存在路径 = 对最深存在祖先 realpath 后拼接余段（现 PathGate.physicalOf 语义——为「写新建文件」的门判定服务；本语义是契约一部分，conformance 锁定） */
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatResult>;
  openRead(p: string): Promise<OpenReadResult>;
  writeFileAtomic(p: string, content: Uint8Array, opts: { readonly makeParents: boolean }): Promise<{ ok: true; stat: FileStat } | { ok: false; reason: "is_directory" | "not_directory_parent" | "access_denied" | "write_failed" }>; // modeIfCreate 缺省 0600；存在文件承袭其 mode 且只收不放宽
  readDir(p: string): Promise<{ ok: true; entries: readonly DirEntry[] } | { ok: false; reason: "not_found" | "not_directory" | "access_denied" }>;
  spawn(req: SpawnRequest): Promise<SpawnResult>;
}
```

契约纪律：pid 不进契约（负 pid 组杀是 localEnv 实现细节，经 `settled`/`kill` 抽象）；kill resolve=
信号已投递（grep 双杀点「kill 后排空再解析」时序以此为准：kill 后读流至 EOF/RST）；selfKilled 归因
标志留 toolbox（「我发起过击杀」——env 不做归因）。

## 2. localEnv（packages/exec-env/src/local/）

现 toolbox 行为原样搬迁为契约实现：`openRead` = fd 流式分块 + **fstat 取版本**（8KB NUL 嗅探逻辑
留 toolbox，经 handle 首 read 组合——嗅探跨块由 conformance chunk 用例锁）；`writeFileAtomic` =
同目录 temp（随机名，`wx 0600`）+ 存在目标 mode 承袭（fstat→fchmod temp）+ rename + 失败清 temp
（**注错缝**：选项注入 `failAt` 分段失败——EIO 中途/短写循环——conformance local 腿可用，接替现
`atomicWrite` ByteSink 缝）；`spawn` = `Bun.spawn(detached: true)` + 负 pid 组杀 + **进程级单例**
liveGroups 登记簿与 host-exit exit handler（模块级，非 per-plugin——dispose 不注销 handler，
quiescence 后仅移除自身条目；dsh「finalizer 前置排序 + 正常 disposal 达 quiescence 前保活」纪律）+
settleGroup 轮询（50ms×100 有界，定时器随 settled 结算清理）。`realpath` = 最深存在祖先归一
（现 PathGate.physicalOf **迁移至此，toolbox 侧删除无双实现**）。`localEnvPlugin(options)` 提供无
围栏 execEnv（现状等价）。wrapper/shell 路径解析忽略模型可影响的 env（my-agent 假二进制防御），
装配期 `Bun.which` 探测一次缓存。

## 3. toolbox 改造 + 存量缺陷修复

六文件改吃 ExecEnv：read 行扫描重写为 async ReadHandle 上的扫描（BOM/carry/字节预算/截断原样迁移）；
**版本登记时序不变量**（fail-closed）：版本取自 openRead 返回的 fd 版本（先于首字节读取）；空文件
（size 0）跳嗅探仍登记；hadBom 组合留 toolbox。`ObservedRegistry` 键控不变（ctx.session 侧无漂移）；
版本元组由 env 产出（全 string，判等即可）。`grep` 双路径不变——rg 经 env.spawn **透传 ctx.session**
（自动同围栏）；`bash` 两段杀节奏/输出帽/截断保尾/spill 全留宿主侧不变（kill/settled 语义见 §1）。
`PathGate.admit` 改 async 并委托 `env.realpath`（词法判定留 gate，物理判定单源在 env）。

**围栏执法面裁决**（审查 A4/A6/B11）：fs 面（openRead/readDir/writeFileAtomic）**无会话概念、
无内核围栏**——工具 fs 面的 denyRead/protectedPaths/根围栏执法全在 **gate/permission 层**（进程内，
所有工具路径必过 gate 单一执法点）；内核 denyRead 剖面只对 **spawn 面**（bash/rg 子进程）生效。
授权根（extraRoots）：permission 批准时记原始路径，**归一责任方 = toolbox gate**（持有 env）——
admit 对授权根内路径**同样执行词法+物理双查**（realpath 复核防 symlink 根直通敏感区）后放行。

**存量缺陷清单（盘点发现，当场修）**：
- D1 mode 漂移：`write.ts:74` temp `wx 0600` + rename——0644 覆写后必漂移 0600（M/D 双仓共同语义
  「承袭且只收不放宽」，实现确实错）。修于 `writeFileAtomic` + 回归用例（症状用例名）。
- D2 stat/open 竞态：现 `sniffHead` open(A) 后 stat 的是**路径非 fd**——并发 rename 下版本与内容
  错配，CAS 失守丢更新（同步代码微秒窗，异步化放大为跨 seam 窗）。根治 = `openRead` 返回 fd 版本
  （§1 原语）+ 并发 read/write 同路径竞态用例。
- D3 `FS_WRITE_FAILED`（父级是文件 ENOTDIR）通道存在但无用例——补。

**存量测试改动口径**（审查 C1/C11）：66 用例**零行为断言改动**；装配行允许机械加
`env: localEnv({ root })` 一行（fail-closed 解析链不被静默回退稀释）；`atomicWrite` ByteSink 注入
用例**移植**为 localEnv 注错缝的 conformance 用例（注入强度不降）。

## 4. sandbox-local：围栏（argv 改写 + 会话代理网络）

**confine 是纯函数**：`confine(argv, fence) → { argv, meta }`，表驱动可测。注入点在
`createSandboxPlugin` 组装的 env 构造期。

```ts
export interface Fence {
  readonly writable: readonly string[];        // realpath 归一：root + tmpdir + 宿主附加（一份清单两层执法：同源喂 gate 与内核剖面）
  readonly denyRead: readonly string[];        // 默认表（用户裁决②）：~/.ssh/** ~/.aws/** ~/.gcp/** **/.env——宿主只可增；fail-safe 过拒（/* 前缀含嵌套）
  readonly protectedPaths: readonly string[];  // permission 配置路径 + session 持久化 root + .git 内部——剖面 deny-write（见下），工具面由 gate/permission 拒
  readonly network: "off" | { readonly allowedDomains: readonly string[] }; // 会话授权域名并入（用户裁决①）
  readonly scrubEnv: true;                     // KEY|PASSWORD|SECRET|TOKEN 清洗（dsh）——内核拦不住读自身 env
}
```

**macOS（Seatbelt）**：SBPL `(deny default)` + `(allow process-exec*)` + `(allow file-read*)` +
denyRead 子路径拒读 + protectedPaths **deny-write 子路径**（优先于 writable allow——SBPL 规则
优先级是**实现期实测点**，e2e 锁定）+ writable 逐段 `(allow file-write* (subpath …))` +
`(allow file-write* (literal "/dev/null"))` + 网络：仅 `(literal "127.0.0.1:<本会话代理口>")` 出站
（其余含 unix socket 全拒——docker.sock 逃逸口）。**Linux（bwrap+socat）**：`--ro-bind / /
--dev /dev --proc /proc --die-with-parent --unshare-net --unshare-pid` + writable 逐目录 `--bind` +
**denyRead/protectedPaths 遮挂**：bwrap 无 deny-read 动词，用 `--tmpfs <path>` 遮蔽该路径
（读得空目录=拒读语义可达）+ socat 桥（下）。

**wrapper 组装模板（Linux 网络）**：inner `sh -c 'socat TCP-LISTEN:8080,fork,reuseaddr
UNIX-CONNECT:/px/sock & exec /bin/sh -c <cmd>'`——socat 为后台兄弟；命令先退时 settle 等满宽限再
KILL socat（**接受 ≤5s 收尾税**，有界；网络命令少数）。pidns init 死亡内核清场兜底孙进程；
**macOS setsid 孙进程宿主退出后存活是已知残留**（无 PDEATHSIG 等价物——落档，VM 档根治），
§7 有 setsid 清场用例（Linux）。

**网络域名白名单（用户裁决①）= 会话级代理**（审查 B2 处置）：**per-session 代理口池**——会话首次
需网时 lazily 起 127.0.0.1:0 专口（SBPL 剖面在 spawn 时以该会话口字面量生成——CONNECT 归属会话
无歧义）；会话终结（`sessionDisposed`）关口。子进程 env 注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`
指向本会话口；域外直连被内核剖面拒；**DNS 不外泄**（CONNECT 携主机名，代理侧解析）。代理对每个
CONNECT 域名问 permission：会话授权集内 → 放行；域外 → broker ask（**socket close 即撤 ask 以
deny 结算**——子进程死/超时不留僵尸 ask）→ 批=记会话授权（含**负缓存**：deny 也会话内记忆，重试
不重弹）+ 放行 / 拒=403。`allowedDomains` 配置预授权（宿主层，永不 ask）。非 HTTP(S) 协议默认全断
（git-https 可用，ssh 不可用——落档）。**代理失败三态**（落档）：代理死 → 新 CONNECT 回环
ECONNREFUSED 快失败（子进程可见）；已建隧道中断；半死挂起由 bash 墙钟兜底。代理生命周期 =
插件生命周期，不重启。

**fail-closed 双保险**（dsh，不学 my-agent 大声降级）：**apply 内先探测后绑定**（seatbelt/bwrap/
socat 按档位探测，缺席 → throw；探测与代理创建顺序防 fd 泄漏，一切资源经 `ctx.effect` 登记）；
运行期 wrapper 中途消失 → spawn `ok:false, reason:{kind:"sandbox_unavailable"}` 回模型，绝不裸跑。
围栏内 EPERM 拒写 = 命令非零退出码可见（非工具 isError——bash 现行口径）。TOCTOU 残留
（TOOLBOX §7 落档项）由内核围栏**闭合**：门被骗过的越根写在内核层仍拒，e2e 回归锁定（symlink
换靶用例）。

## 5. permission：完整规则词汇表 + auto 决策 + 拆卸契约（用户裁决④）

**规则语法**：`Bash(git push:*)` 前缀段规则 / `Read(~/.ssh/**)`、`Write(…)`、`Grep(…)` 路径 glob /
verdict ∈ allow|deny|ask / origin ∈ user|session（后来源同 verdict 覆盖；**deny 压过一切**——含
full 档）；词法开放但**拼错 fail-closed 拒启**。

**bash 命令裁决管线**（纯函数；解析底座=tree-sitter-bash AST——§14，段词法器已删）：
1. **deny 规则**（词面前缀匹配）确定性拒绝；
2. **硬拒底线**（`rm -rf /`、`sudo`、`git push --force`、`chmod -R 777`；引号拼接/反斜杠/级联/
   env 前缀逃脱由 AST 词面重构与包装器剥离消）→ 恒 ask，**NEVER_MEMORIZE**（会话授权永不记
   allow——授权投毒拒绝）；
3. **注入**（AST 节点级 6 kind：命令替换 `$()`/反引号/进程替换/赋值右值/heredoc 体、管道末位
   shell × 上游 fetcher/base64、payload 空载荷、eval 动态兜底）→ ask，压过 full 档与 allow；
4. **结构失败**（包装器未知旗/剥后残渣/载荷传染）→ ask（allow 不可越）；**dynamic**（展开/通配
   词）auto→ask / full→过；
5. **重定向双面裁决**——算符全矩阵 `>`/`>>`/`2>`/`2>&1`/`&>`/`>&`/`>|`/任意 fd 前缀 + 输入 `<`
   （denyRead 表 deny，不做越根 ask）：输出目标越根/`..`/`~` 归一后越根 → ask；界内 allow；
6. **allow 规则** → **不透明信任类**（source/解释器文件/stdin/字符串实参代码——可被 allow 以
   用户信任越过）→ **围栏事实合成**：命令全过且界内 → **auto-allow**。`needs_network: true`
   声明位（dsh 思想）：声明 → 路由 ask；未声明撞断网 EPERM → 错误文案含自行声明指引。

**模式档**（闭集）：`plan`（write/bash 全拒，read/grep 界内 auto）/ `auto`（缺省，全流程）/
`full`（**完全访问——用户裁决⑤：不拦截任何命令，唯提权/密码类（sudo/doas/su，含包装/载荷/
$() 内嵌形）直接 deny**；越根写/网络面由围栏内核承载；用户 deny 规则仍最高）。

**ask 内嵌监听器**（dispatch 契约零改动）：permission 注册 `toolsPreExecute` 监听器，ask = 监听器
内 `await broker.ask(req)` 后返回 allow/deny；**broker 缺席 → ask 退化 deny**。broker token：
`permissionBroker.ask(input): Promise<"allow" | "deny">`；宿主接 UI/CLI，e2e 可编程假体；无内核
超时（宿主自治），pre-execute 无 abort 语境（调用未开始），CONNECT 侧 ask 撤销 = socket close。

**会话授权集**（`permissionGrants`）：`{ domains: Map<domain, allow|deny>, extraRoots: Set, rules:
Map }` 按会话键控（ObservedRegistry 同款纪律；**锁粒度 per-(session,domain)**：临界区 =
check→ask→record——同域并发 CONNECT 只产生一次 ask，异域并行不互相头阻塞；extraRoots 写入同
per-session 互斥）；**会话终结逐出**（`on(sessionDisposed)` 关桶——delegation 子会话生生灭灭不
累积；ObservedRegistry 自身的无逐出问题本件一并修，同事件）；resume 不继承（fail-closed）。
会话授权只增不减（本件口径；撤销通道落档后续）。

**审计**：每裁决发 `permissionDecided` 事件（tool/verdict/resolvedBy/reason/session；次数断言）；
会话流持久化归属 session 件。

**受保护路径**（Claude Code 思想）：permission 配置文件、session 持久化 root、`.git` 内部——
**工具面** gate/permission 拒 + **spawn 面**内核剖面 deny-write（macOS）/tmpfs 遮挂（Linux）各挡
一道；反探测（my-agent BUG-14 五象限）：拒读/保护错误不泄漏目标存在性。

**插件拆卸契约**（审查 B1/B8 处置，delegation 纪律同源）：
- **sandbox dispose**：停 fence 解析（新 spawn fail-fast `sandbox_unavailable`）→ 对活围栏组两段杀
  → `await settled`（有界 5s）→ 关 per-session 代理口池（在飞 CONNECT 以 socket close 撤 ask→
  deny 收尾）→ 移除登记；不注销进程级 exit handler（仅清自身条目）。
- **permission dispose**：在飞 ask 全部以 deny 结算 + 拒新 ask + 注销监听；grants 桶随会话逐出兜底。
- **exec-env（localEnv）**：进程级单例 handler 存活到进程退出；dispose 语义 = quiescence 后条目
  自清（在飞 settleGroup/killUpgrade 定时器随 settled 清理，无跨 dispose 泄漏）。

## 6. 决策流时序（bash 一次调用）

```
模型 tool_use bash{command, needs_network?}
→ tools.dispatch → toolsPreExecute waterfall
   → permission 监听器（纯函数裁决管线 + fenceFacts（会话 fence 快照，与 spawn 同一解析函数产物））
      界内且无危险 → allow（零交互）
      界外/危险/needs_network → broker.ask → 批：grant 入会话集 → allow / 拒 → deny(reason)
      broker 缺席 → deny（fail-closed）
→ toolsExecute → bash.execute → env.spawn({argv:["/bin/sh","-c",cmd], cwd, session})
   → sandbox env：fenceFor(session) = base ∧ grants（单一解析函数，决策与 spawn 共用；域名/根授权
     即时生效于后续同会话调用是设计意图——一切出站仍受白名单+ask 约束，执法不弱化）
   → confine(argv, fence)（argv 改写 + env 清洗 + 代理注入[本会话口]）→ Bun.spawn
→ 子进程 CONNECT api.example.com（未授权）→ 会话代理 → permission → ask（首用域交互）→ 批/拒
→ kill(phase)/settled + 两段杀节奏/输出帽/截断/spill（宿主侧 bash.ts 不变；wrapper 下 e2e 锁定）
```

fence 由**服务端组装**（spawn 时按 session 解析），模型入参无此字段、注入无效。无 sandbox 装配：
fenceFacts 缺席 → bash 永不界内 auto（按规则/ask/deny 裁决），read/write/grep 界内判定退化为
「root 内」。**同会话 bash 排他性（缺省 exclusive）是 fence 会话一致性的前置条件**——将来若放开
bash 并发必须先复核本条（落档）。

## 7. 测试口径（真异常、反假绿）

**契约一致性套件**（参数化 × 实现，用例逐条标 `both | local-only | fake-only`；**local 腿对内核级
语义权威——fake 腿不得弱化 both 断言**）：`exec-env/__test__/conformance.ts` 同套件跑 `localEnv`
（真盘 mkdtemp + 注错缝）与内存 fake（契约隔离 + 远端预演）；逐条锁 §1 判别联合全分支（not_found/
not_regular/access_denied/is_directory/**not_directory_parent**/write_failed/io_error/sandbox_
unavailable…）、**realpath 不存在路径语义**（最深存在祖先归一——跨实现一致）、流式 chunk 边界
（BOM/CRLF/多字节/8KB 嗅探跨块）、writeFileAtomic 原子性（注错 EIO 中途→原文完好无 temp 残留；
短写循环续写）、**mode 承袭回归（D1 症状用例名）**、**fd 版本原子性（D2——并发 read/write 同路径
竞态：rename 后 read 的版本必属实际读到的 inode）**。

**围栏**：`confine()` 表驱动——SBPL/bwrap argv **内容级断言**（writable 逐段、/dev/null 字面、
denyRead 子路径、protectedPaths deny-write/tmpfs 遮挂、netns flag、unix socket 拒、**仅本会话代理
口字面量**）；probe 注入假 which（internals 缝）；拒读/保护集矩阵含反探测五象限（存在/不存在同错）。

**代理**：in-process——CONNECT 授权域放行/未授权经假 broker 批→记授权→放行/拒→403 且**负缓存生效
（重试不重弹）**/broker 缺席→拒/**socket close 撤 ask（子进程死后无僵尸 ask）**/`allowedDomains`
预授权不触发 ask/**同域并发 CONNECT 只一次 ask、异域并行**（per-(session,domain) 锁断言）/
**CONNECT 会话归属隔离**（A 会话口收到的 CONNECT 不查 B 会话授权）。

**权限**：AST 解析矩阵（控制流/函数体/后台 &/子壳/未闭合/`$<`/`<>` → unparseable 保守 ask；
**分类闭集穷尽性三锁**——真读语法包 node-types.json，supertype 过滤 + 计数哨兵 59 + 恰归一类，
grammar 升级加 kind 必红）；注入 6 kind（节点级）+ 硬拒逃脱形（引号/反斜杠/级联经词面重构）+
NEVER_MEMORIZE 投毒；**包装器剥离矩阵**（exact/bounded × sudo、未知旗 fail-closed、剥后残渣）；
**解释器载荷**（-c 再解析/传染/文件操作数/stdin/赋值前缀/管道喂入）；payload（xargs/find -exec
空载与良性）；前缀规则精确匹配；**重定向算符全矩阵双面**（输出 × 界内/越根/../~；输入 ×
denyRead 表 + 反向钉不越根 ask）；**reason 快照**（全 reason 词表逐条钉死）；**needs_network
声明/未声明双路**；deny 压过 allow 含 full 档与注入（裁决序重排锚）；来源覆盖；拼错规则拒启
（apply throw）；三模式档矩阵；broker 缺席 ask→deny；审计事件每裁决一条（次数断言）；会话授权
隔离（A/B 互不借用）+ **sessionDisposed 逐出**（桶关、代理口关）。

**真内核 e2e（sandbox journey 进 main.ts 默认门——审查 C3 处置）**：wrapper **在场时 skip>0 即旅程
失败**（darwin seatbelt 恒在=必须执行；缺席腿仅限真实探测缺席且 console 计数=探测缺席数）；linux
腿（bwrap/socat）仓库内 darwin 开发机不执行——**§8 标 known-untested in-repo**，提供
`X_HARNESS_REQUIRE_LINUX_FENCE=1` fail-if-unexecuted 开关给 T9 外部矩阵，§12 核销要求 T9 证据。
旅程用例：越根写拒（EPERM 可见非 isError）/根内写过/拒读表生效/**直连外部 IP 拒**（无视代理 env
的子进程——审查 C5）/**非代理回环口拒**（本地起非代理监听，抓 SBPL loopback 过宽）/**DNS 泄漏拒**
（直连 UDP/53）/真 CONNECT 经会话代理放行+会话隔离/组杀与 host-exit 在 wrapper 下清孙进程/
setsid 孙进程清场（linux；macOS 标已知残留）/两段杀 wrapper 下/TOCTOU 回归（根内 symlink 换靶
指根外→写拒）/spill 字节等值+截断保尾+双流不堵管 **fenced 腿**（pipe 经 wrapper 的块时序变化）/
**handler 生命周期两条**（dsh：finalizer 前置排序；quiescence 前保活）。

**回归**：存量用例**零行为断言改动**全绿（装配行机械加 env；atomicWrite 注入用例移植 conformance）；
e2e 默认门四旅程不变 + sandbox 旅程新增。

**覆盖率 vs 平台死代码**（审查 C10）：bwrap/socat 组装与探测**结构上纯函数化**（argv/profile
构造可全平台单测），syscall 触达点收敛为薄层（e2e + probe 注入缝覆盖）——vitest exclude 不加
平台项（只升不降诚实口径）；禁止 mock-spawn 凑数；若平台分支仍拖低数字，收口时如实报告分项。

## 8. 三仓语义子集对照矩阵（用户指令②——真缺口清单）

每行标注覆盖腿 `unfenced | fenced | both` 与实现状态。共同子集 33 条（≥2 仓测试验证）：
read 窗口 7 条已覆盖（unfenced，66 用例）；write 8 条**缺 2**：mode 保持（真缺口=存量 bug D1）、
并发 read/write 同路径竞态（D2——openRead fd 版本原语补）；**另有 D3（ENOTDIR 父级是文件）通道
存在无用例**；exec 12 条中 11 条已覆盖（unfenced；组探活为 marker 法间接断言——措辞如实），
**spawn 失败（SPAWN_FAILED）无用例——真缺口，本件补**；其余 11 条（两段杀/trap-exit-0/截断保尾
三件套/撕裂 UTF-8/ANSI/workdir 预检/host-exit/pre-abort 等）已覆盖（unfenced）；fenced 腿已补：
组杀+spill 字节等值+截断保尾+双流三件套（darwin 真内核）；DNS 拒腿以「解析不得成功」口径断言
（无外网 CI 上弱化——与真 CONNECT 腿合读）；路径 3 条已覆盖；围栏 4 条（rwDirs/symlink 闭合/
/tmp 归一到内核层/拒绝文案含模式与升级指引）**本件新增**——其中 **linux 运行时腿 known-untested
in-repo**（argv 内容级 + darwin 全腿 + T9 外部矩阵承载；linux allowlist 桥的 unix socket 代理
已实现——T9 腿首跑即验）；权限 5 条（升级声明+先批后执/会话级
覆盖/deny 压过 allow/每裁决审计）**本件新增**。单源高值吸收：spill 注入加固（换行 spillDir/恶意
前缀回退）入册；反探测五象限入册；ghost 部分标记驱逐不适用（我们行窗实现无此形态，落档）。
分歧裁决（沿用既有文档）：symlink 写=替换链接本身；非零退出=非 isError；页脚文案=本仓自锁。
**新覆盖率要求**：三新包行/语句/函数 ≥90、分支 ≥85（门禁阈值只升不降）。

## 9. 不处理（归属）

容器/远端 VM/E2B（整 ExecEnv 兄弟实现，后续件）；Windows（POSIX-only）；按域名 TLS 终结与凭据
注入（代理透传 CONNECT 不 MITM；凭据防护仅 env 清洗）；Landlock 档；rlimits/fork bomb（墙钟+
输出帽部分兜底，VM 层正解）；审计入会话流（session 件）；审批 UI/CLI 宿主；danger 豁免档接入
形态（配置留位）；BASH_ENV 时序（不注入 BASH_ENV）；pi 式模糊路径匹配（可用性特性，落档）；
会话授权撤销（只增不减）；**macOS setsid 孙进程宿主退出残留**（无 PDEATHSIG 等价，落档）；
spill 走 env fs 面（宿主运维产物豁免——
「六文件全部经 ExecEnv」的明文例外）。

## 10. 实施批次（单件交付、内部小步）

- **B0 de-risk 垂直切片（大级试运行）**：exec-env 契约 + localEnv 的 read 面 + toolbox read 异步化改造
  + conformance 套件（local+fake）read 面用例走完整闭环（实现→测试→审查→四门）——验证流程
  本身；切片代码即正式代码，演进不重写；
  实施注记（2026-09-19）：B0 拆两步落地——**B0′=exec-env 包独立闭环**（契约+local read 面+
  conformance 双腿，纯新增文件；因件10 grep 单路径返工在途占用 toolbox.ts，避让他人未提交变更）；
  **B0.5=toolbox read 接入**（在途返工落库后）；
- **B1** exec-env 全量（write/spawn/readDir/注错缝）+ toolbox write/bash/grep/paths/observed 改造
  + D1/D2/D3 修复回归 + 存量用例装配行适配 + e2e toolbox 旅程绿（行为零变化）；grep 侧随件10
  单路径裁决对齐（rg 经 env.spawn 透传 session——方案 §6 语义不变）；
- **B2** permission 包（纯函数规则引擎 + grants + broker + 审计 + 拆卸契约 + toolsPreExecute 集成）；
- **B3** sandbox-local（confine/probe/会话代理/受保护集/env provider/拆卸契约）+ 真内核 e2e 旅程；
- **B4** 收口：代码对抗审查（≥2 路）、四门、覆盖率数字如实、验收清单核销。
每批四门全绿独立提交，提交信息引用本文件节号。

## 11. 方案审查处置（A 契约语义 / B 并发生命周期 / C 测试假绿，三路并行）

**采纳（A，P0×4+P1×6+P2×5+P3×2）**：ProcHandle 加 `settled` 观测面+kill 幂等/投递即 resolve，
两段杀归属劈半缝合（§1）；stat 改判别联合保 EACCES（§1）；ReadHandle.read 加 io_error 通道禁假
EOF（§1）；extraRoots 归一责任=toolbox gate+词法物理双查+fs 面/spawn 面执法层裁决（§3）；
protectedPaths 进剖面（SBPL deny-write/bwrap tmpfs 遮挂）+Linux denyRead 可实现化（§4）；mtimeNs
等全 string（§1）；realpath 语义钉死进契约+physicalOf 单源迁移（§1/§2）；§8 计数口径改运行期+
D3 入缺口（§0/§8）；readDir/SpawnResult reason 闭集（§1）；版本登记时序不变量+空文件/hadBom
落死（§3）；modeIfCreate 缺省 0600（§1）；信号死亡 code null+signal 归一+selfKilled 归属点名
（§1）；walker 双往返与「全部经 env」措辞豁免落档（§9）——walker 已随 grep rg 硬依赖化删除
（docs/TOOLBOX.md §5），豁免条目仅对 rg 子进程内 I/O 语义残留适用。
**采纳（B，P0×3+P1×5+P2×3+P3×2）**：插件拆卸契约成节（§5——sandbox 两段杀→settled→关代理池、
permission ask 全 deny 结算、exit handler 进程级单例+quiescence）；代理改 **per-session 口池**
（CONNECT 会话归属无歧义，§4）+会话终结关口；ask 撤销=socket close+负缓存防重试风暴（§4/§5）；
锁粒度 per-(session,domain) 含 ask 同域单问（§5）；fenceFor 单一解析函数+授权即时生效落档为设计
意图（§6）；wrapper 组装模板+socat 后台兄弟 5s 收尾税+macOS setsid 残留落档+setsid 用例（§4/§7）；
openRead 返回 fd 版本根治 stat/open 竞态=D2（§1/§3）；grants/代理口会话逐出（sessionDisposed，
ObservedRegistry 一并修）（§5）；代理死亡三态（§4）；bash exclusive 前置+所有 spawn 点透传
session（§6）；apply 先探测后绑定+ctx.effect 登记（§4）；授权撤销落档（§9）。
**采纳（C，P0×2+P1×4+P2×4+P3×2）**：零改动口径改「零行为断言改动」+装配行机械适配（§3/§7）；
验收基数以 vitest 运行期报告机械再生（§0/§12）；sandbox journey 进默认门+在场 skip>0 失败+删
计数逃生口（§7/§12）；linux 腿 known-untested+REQUIRE knob+T9 证据（§7/§8/§12）；负向网络三腿
（直连/非代理口/DNS）（§7）；重定向算符全矩阵+变异角度+needs_network 双路（§5/§7）；conformance
三档标注+localEnv 注错缝+local 权威（§2/§7）；spawn 失败移入真缺口（§8）；§8 行标覆盖腿+
fenced 四行为腿（§8/§7）；覆盖率平台策略=纯函数化+禁 mock 凑数（§7）；atomicWrite 注入移植
（§3）；组探活 marker 法措辞（§8）。
**落档驳回**：无（三路全部采纳或落档）。

## 13. 代码审查处置（A 契约对照+假绿面 / B 并发生命周期+安全——实施收口前两路并行）

**采纳（A，P1×4+P2×7+P3×5）**：fenced 四行为腿补齐（spill 字节等值/截断/双流真内核腿）；linux
allowlist 桥 unix socket 代理接入（结构性断路闭合）；SBPL 次序争议实测裁决（deny-read 仅非锚定
regex 有效、deny-write 带过滤器必杀全写不可用——剖面按实测重写）+ 拒读腿确定性装置
（denyReadExtra 实种文件——真拒非缺失，反探测内核层不可达如实断言 ENOENT）；protectedPaths 默认
并入 root/.git + **/.env 内核拒读不可表达落档（darwin 无后缀/任意深 deny 谓词）；socket-close 撤
ask 实现（abort 竞速——迟到 allow 丢弃不记账）；broker-批正向断言 200；界内 auto 实现（fence 在场
无规则静态段零交互——§6 决策流落地，无 fence 对照句锁定）；grep/read path 缺省镜像 root；gate/env
root 一致性断言；sandbox 旅程口径改真话（内核腿在 vitest 默认门）；env -i/-u/-- 前缀 flag 剥离
（硬拒不可越）；wrapper 绝对路径化；read.ts 头注释修正；knownHadBom 空文件行为变更补录 §3 口径
（BOM round-trip 连续性改进——改进了但未申报，现申报）。
**采纳（B，P1×4+P2×5+P3×3）**：代理双建竞态记忆化（creating Map——并行 spawn 单飞）；extraRoots
全链打通（gate.admit 授权根参数——词法+物理双形双查实测 macOS /var→/private/var；四工具透传；
fence.writable 并入；端到端三腿：批→放行真实读出/拒批维持拒绝/重定向可写授权目录）；allowedDomains
preAllowed（代理侧永不 ask）；ObservedRegistry 会话逐出（sessionDisposed 四插件挂接）；SBPL 注入
双层转义（regex 元字符+字面量引号——extraRoots 模型可达路径安全）；grants 域链随桶逐出；拆卸窗口
spawn 逃逸复查自杀；**决策口径修正：read/write/grep 界内判定回归 gate 语义（root ∪ extraRoots），
fence.writable（含 tmpdir）只供 bash/spawn 面**——两层口径漂移是审查发现的真架构缺口。
**落档（未修，理由）**：darwin wrapper 探测缺席仍回退绝对路径（系统内建恒在，spawn 期 exit 65 暴露）；
PathGate realpathOrSelf 残留（构造期早于 env 解析的结构性残留，行为与旧代码等价）；代理 200 早写
（上游异步失败时 502 入隧道——协议疣，无害）；代理仅 CONNECT（http:// 绝对形式 GET 405——allowlist
即 https 语义，与「非 HTTP(S) 全断」一致）；代理裁决审计事件（复用 permission 审计面——后续）；
fenced host-exit 生命周期对（host-exit 单例在 exec-env 有 unfenced 真子进程腿——fenced 变体并入
T9 矩阵）。

## 12. 验收清单

- [x] §1–§6 逐条；§7 测试口径全绿；§8 矩阵无未处置缺口（fenced/known-untested 口径已按实改真话）
- [x] 存量用例零行为断言改动全绿（装配行机械加 env；atomicWrite 注入用例按 §3 移植条款由
      exec-env conformance 承接）；收口时 vitest 运行期 879 用例全绿
- [x] 真内核腿在 vitest 默认门（darwin 全腿执行；wrapper 在场 skip=0）；linux 腿 known-untested
      in-repo + T9 承载（X_HARNESS_REQUIRE_LINUX_FENCE=1 fail-if-unexecuted 开关在库）——
      T9 矩阵证据由 T9 附于发布核销（仓库内无可执行环境，如实标注）
- [x] 四门全绿（typecheck/oxlint 0-0/build/test）；覆盖率：exec-env 100 全项、permission
      95+/90+/92+/100、sandbox-local 90.47/83.69/92.85/92.96（分支 83.69<85 如实报告——
      darwin-only 开发机不可达的 linux 桥分支为缺口主体，纯函数已假体覆盖；禁 mock 凑数）；
      全局 93.95/90.17/95.31/96.41；≥2 路代码对抗审查（A/B）问题全处置（§13）
- [x] 存量缺陷 D1（mode 漂移）/D2（stat/open 竞态）/D3（ENOTDIR）修复 + 回归用例在库

## 14. bash 裁决 AST 化（tree-sitter 迁移）——件12

> 状态：方案定稿（2026-09-18；初稿经三路并行对抗审查——契约语义/安全 fail-closed/测试假绿——
> P0×9 全处置后整体重写，处置明细见 §14.9）。§5 bash 管线的解析底座由手写两遍词法器换
> tree-sitter-bash AST，政策层（裁决序骨架/规则词汇表/三模式档/grants/审计）不变。
> 实施=单批次（§14.6），代码收口前另起 ≥2 路对抗审查。

### 14.0 动机：手写段解析器的实证漏洞（8 形，全部经现行管线实跑复现）

现行 `bash/segments.ts` 只按 `;` `|` `&&` `||` 换行 `(` `)` 切段、取段首词作 argv0 做硬拒/规则
匹配。以下形态让真命令藏在关键词/包装词后面，**硬拒底线（NEVER_MEMORIZE）被穿透**（fence 在场
+ auto 档 + `Bash(*):allow` 下全部终态 allow，实证）：

| # | 形态 | 现状解析结果 | 后果 |
| --- | --- | --- | --- |
| 1 | `if true; then sudo id; fi` | 段 argv0 = if/then/fi | sudo 硬拒漏网，界内 auto-allow |
| 2 | `ls & sudo id` | `&` 非切分符，单段 argv0=ls | 同上 |
| 3 | `f() { sudo id; }` | words=[f,`{`,sudo,id]，argv0=f（函数名） | sudo 藏在函数体词列里 |
| 4 | `while true; do rm -rf /; done` | argv0 = while/do/done | rm-rf-root 漏网（字面量 `/` 目标不兜） |
| 5 | `FOO=bar sudo id` | argv0=FOO=bar（env 赋值前缀只在 argv0=env 时剥离） | sudo 漏网（AST 实证 `variable_assignment` 是 command 子节点） |
| 6 | heredoc 体逐行当命令裁决 | 解析即错误：体行会命中规则/硬拒（假阳性方向），规则 allow 也可能匹配体行 | 语义全错 |
| 7 | `echo "a > /etc/passwd" > f` | redirect 正则扫原文，引号内 `/etc/passwd"` 误作越根目标 | 假阳性 ask（界内目标变体则漏放） |
| 8 | `cmd < /etc/passwd` | `<` 完全不裁决（redirect.ts 只认输出算符） | 输入面零执法 |
| + | `cat <(sudo id)` | `(` 配深入段原文，words=[cat,<,sudo,id]，argv0=cat | 进程替换内命令漏网 |

其中 1–5 与 + 是硬拒底线穿透（模型一条命令绕过 NEVER_MEMORIZE），不是可用性问题。

### 14.1 载体实测（2026-09-18，Bun 1.4.2 / darwin arm64 / 仓库 vitest 5）

| 载体 | bun 运行 | 仓库 vitest worker | bun build | 结论 |
| --- | --- | --- | --- | --- |
| 原生 `tree-sitter@0.22` + `tree-sitter-bash@0.23.3` | ✓ | ✓（真探针用例过） | ✓（`--external` 后运行通；本仓 build 门现仅打 core——不触发） | **采纳** |
| WASM `web-tree-sitter` 0.22.6 / 0.24.7 + 包内自带 bash.wasm | init ✓ 11ms，**parse 恒抛 "Parsing failed"** | — | — | Bun wasm 运行时坑（非 ABI 配错，两条版本线同症）——**不可用** |

- 原生两包各带 6 平台 prebuilds（darwin/linux/win32 × arm64/x64），**安装免编译**；Bun 拦截的
  `node-gyp-build` postinstall 仅为 prebuilds 缺席平台的兜底，运行期直读 prebuilds 目录。
- 依赖落 `@x-harness/permission`（唯一直接消费方）；WASM 修复后可经 ast.ts 单封装点平移。
- 装载失败（平台缺席/损坏）→ `parser-unavailable` → **bash 全量 ask**（fail-closed 降级，
  不崩溃、不裸放行），测试锁定（§14.5-5）；另有常驻装载冒烟锚用例（§14.5-5）。
- 深嵌套输入（20k 层 `$( $( … ) )`）parse 本体不抛但 JS 递归遍历会 `RangeError`——parseBash
  整体 try/catch → unparseable（审查 B-P1-6，垃圾输入不崩溃）。

### 14.2 新增模块 `bash/ast.ts` + `bash/wrappers.ts`（实现期按「一动词一文件」拆两文件：
> ast=语法层（解析/遍历/词面重构/重定向提取），wrappers=argv 政策层（包装器/解释器/payload）——
> 方案与代码同变注记；parseBash 仍是唯一公共入口，wrappers 经注入的 reparse 回调无环）

```ts
export interface ParsedCommand {
  readonly argv: readonly string[];          // 词面重构后的干净 argv（剥引号/转义/拼接）
  readonly dynamic: boolean;                 // 存在 shell 会展开/通配的词（auto→ask / full→过）
  readonly injection?: InjectionKind;        // 命令替换/载荷入解释器等（压过 full 与 allow）
  readonly redirects: readonly Redirect[];   // 全算符矩阵 + 目标（词面）；fd 复制/关闭无目标
  readonly raw: string;                      // 命令原文（审计/回归定位）
}
export type BashParse =
  | { ok: true; commands: readonly ParsedCommand[] }
  | { ok: false; kind: "unparseable" }       // ERROR/MISSING、未知 kind、遍历异常、结构残渣
  | { ok: false; kind: "parser-unavailable" }; // 载体装载失败（memoized）
export function parseBash(src: string): BashParse;   // 同步；adjudicateBash 签名不变、decide/plugin 零改动
```

**装载**：懒加载单例（`createRequire` 首次调用时 require 两包，try/catch → memoized unavailable）；
**parseBash 本体（parse+遍历）整体 try/catch → unparseable**。

**遍历分类闭集**——数据源=语法包自带 `src/node-types.json`：named 共 62 条，其中 3 条
supertype（`_statement/_expression/_primary_expression`）运行期不物化、穷尽性测试过滤；
**可见 kind 恰 59 个，每个恰归一类**（§14.5-5 穷尽性测试按此文件锁定，grammar 升级新增 kind
→ 红测试强制归类）：

| 类别 | 处置 | kind（59 全集） |
| --- | --- | --- |
| 容器（30） | 深入子节点继续收命令（含 command 的非词法子件——审查 B-P1-2：`time (sudo id)` 的 subshell 必须递归） | program list subshell compound_statement if_statement elif_clause else_clause while_statement for_statement c_style_for_statement case_statement case_item do_group function_definition pipeline negated_command redirected_statement variable_assignment variable_assignments declaration_command array heredoc_body test_command binary_expression unary_expression ternary_expression postfix_expression parenthesized_expression brace_expression subscript（后 7 个纯算术内部，只含词件，递归无害） |
| 叶提取（2） | 成型 ParsedCommand（子件分派：词面入 argv、file_redirect 入 redirects、容器子件递归收集；**剥后 argv 为空（如纯 `time` + subshell）→ ask**） | command unset_command |
| 词面部件（20） | 不产命令；重构词面/打标记：`simple_expansion expansion special_variable_name arithmetic_expansion ansi_c_string extglob_pattern` → dynamic；`command_substitution process_substitution` → **无论位置** dynamic+injection+递归收集内嵌命令 | command_name word string string_content raw_string translated_string ansi_c_string concatenation number simple_expansion expansion special_variable_name variable_name arithmetic_expansion command_substitution process_substitution regex extglob_pattern file_descriptor test_operator |
| 宿主消费（3） | 由 command/redirected_statement/容器处理时消费，不独立遍历：算符=**匿名子节点文本**（`>` `>>` `2>` `2>>` `&>` `>&` `>\|` `<`）；descriptor=`file_descriptor`；destination：`word`→路径裁决 / `number`→fd 复制跳过 / `process_substitution`（`> >(cmd)`）→递归收集**不裁决目标** / 缺（`>&-` `<&-`）→跳过 | file_redirect heredoc_redirect herestring_redirect |
| 惰性（4） | 不产命令不标记（heredoc_start 文本用于判定界符是否带引号） | comment heredoc_start heredoc_content heredoc_end |
| **未知** | **unparseable（fail-closed）** | 其余一切 |

- **词面重构**：`sud''o` → command_name=concatenation(word,raw_string,word) → 剥引号拼得
  `sudo`（实测）；重构次序=先剥转义/引号、**再** basename 归一（`s\udo` 类）；重构后的文本
  **不重扫 `$`**（dynamic 只由展开节点类别判定——`echo \$HOME` 字面形不误标）；glob 扫描只对
  **word 部件原文**扫 `* ? [`（引号部件 AST 天然排除 `echo "*"`；`~` 确定性展开不扫，与现行
  同）；转义形 `\*` 误标 dynamic 属可接受保守（落注）。
- **ERROR/MISSING 节点 → unparseable**（实测：未闭合引号、`if true then` 缺分号、`<>` 算符、
  `$<` 均产出——现行「未闭合引号→ask」口径免费保留且更宽）。
- **命令替换全覆盖**：`$( )`、反引号、双引号内嵌、赋值右值、数组元素、`[[ ]]` 内、
  here-string、非引号 heredoc 体（实测 `heredoc_body` 内真实暴露 `command_substitution`）——
  外层打 injection + **内层命令递归入裁决列表**（`$(sudo id)` 由内层硬拒兜住）。

**边界规则**（实测驱动；编号被 §14.9 处置表引用）：

1. **heredoc**：非引号定界（heredoc_start 文本不含引号）→ 整命令 dynamic（体会展开；`<<-`
   tab 形 AST 体节点为空而 bash 真执行——实测盲区，uniform dynamic 覆盖）；引号定界 → 纯字面
   惰性；体内 `command_substitution` 照常递归 + injection（压过 full）。`<<$X` 类展开界符 →
   ERROR → ask（保守正确）。
2. **重定向全算符与双面裁决**：输出面算符 `>` `>>` `2>` `2>>` `&>`（`&>>` 归并） `>&`
   `>|` 与**任意 fd 前缀**（`3> x` 的 descriptor+word）——目标 `~`/`..` 归一后越 root∪extraRoots
   → ask（现行语义）；fd 复制/关闭（destination=number 或缺）跳过；`/dev/null` 围栏许可。
   **无命令纯重定向**（`> /etc/passwd`，redirected_statement 无 body）→ 产出 argv=[] 的
   ParsedCommand 携带 redirects 入裁决（仅裁决 redirects——堵审查 A-P0-1 越根 truncate 放行）。
   **输入面**（`<`）：目标命中 permission `DEFAULT_DENY_READ`（types.ts 工具面表——内核面
   darwin 不可表达是 §13 落档项，两层口径在此绑定）→ deny（reason `redirect-read:`）；**不做
   越根 ask**——argv 文件实参（`cat /etc/passwd`）本就不做根裁决，输入重定向单独加越根 ask 只
   会逼模型换写法、零安全增益；读敏感面的真闸门是 denyRead 表（`**/.env` 在 bash argv 实参面
   的裸穷与 make/npm run 等不透明面一并落档 §14.9-落档）。
3. **包装器剥离表**（~~argv 级全表~~ **§14.12 裁决⑥收敛：剥离只剩 env/nohup/time 平凡三件，
   其余已知运行器统一「提权词扫描命中 → 硬 ask；干净 → opaque（allow 可委托）」——下表细节为
   历史记录**；fail-closed 口径不变）：
   - exact-strip（无自身参数）：`nohup` `setsid` `time`（容 `-p`）`exec` `command`（容 `-p`）
     `builtin`；
   - bounded-skip（有界跳参）：`env`（-i / -u X / -- / 赋值前缀；**遇 `-S/--split-string` →
     恒 ask**——载荷即命令行）`timeout`（时长实参 + --signal/--kill-after/-k）`nice`
     （-n N/-N/--adjustment）`stdbuf`（-o/-e/-i L）`watch`（-n N）；
   - payload 提取（实参即命令）：`xargs`、`find -exec/-execdir/-ok`（终止符 `\;`/`+` 在
     concatenation 词内按词面识别）、`parallel`——payload 词再跑硬拒；payload **为空、含解释
     器、含展开 → ask**（堵审查 A-P0-2：`printf "sudo id" | xargs sh -c` 空载荷 stdin 填充）；
   - 恒 ask（载荷静态不可还原/不透明代码面）：`source` `.` `ssh` `docker` `podman` `kubectl`
     `osascript` `script` `coproc` `strace` `ltrace` `valgrind` `env -S`，及**字符串实参代码
     执行形**（`awk/perl/python*/ruby/node -e/-c` 且 flag 后存在字符串实参、`git -c`——
     审查 B-P0-5 家族）；
   - **剥后健全性检查**：剥离结果 argv0 ∈ 结构残渣集（`{` `}` then fi do done 等，实测
     `time { sudo id; }` 解析成 argv=[time,`{`,sudo,id]）或 argv 空 → ask。
4. **解释器家族**（~~四规则矩阵~~ **§14.12 裁决⑥原则化：EXECUTORS 词表 × 一条规则——任何
   实参/输入面重定向/stdin 喂入/赋值前缀 → opaque；唯 bash 族 -c 字面量再解析与 bun 子命令
   （§14.11）例外；下列矩阵为历史记录**。家族：sh bash zsh dash ksh ash node bun deno python
   python3 ruby perl php）：
   - `-c`/`-lc` + **字面量**载荷 → 递归 parseBash 并入裁决列表（`bash -c 'sudo id'` 由内层
     硬拒兜住）；载荷动态/空 → ask；**载荷再解析 unparseable → 外层 ask（传染语义）**；
   - **脚本文件操作数（`bash x.sh` `node s.js`）→ 恒 ask**：文件内容不可静态裁决，且围栏
     不拦 process-exec——sudo 可在脚本内运行（审查 B-P0-1 实证零交互链）；
   - **stdin/heredoc/管道喂给解释器（`bash < x.sh`、`sh <<'EOF'`、`echo "sudo id" | bash`）→ 恒
     ask**（管道 stdin 不是 redirect——实现期覆盖分析发现的新面，pipeline 非首位解释器补位执法）；
   - **解释器命令带赋值前缀 → 恒 ask**（`BASH_ENV=x bash -c ':'` 类环境注入链，审查 B-P0-1）；
   - **-c 载荷动态 → 结构失败类 ask**（`bash -c "$x"`——full 档不得因 dynamic 早退放行——实现期发现）。
   - `make`/`npm run`/`bun run`/`yarn`/`pnpm run` 不透明配置执行 → **落档**（与现行等价
     auto-allow；配置文件写入已被 Write 门控、执行受围栏；.git 写/.env 读 darwin 内核缺口
     是 §13 已载残留——审查 B-P1-10 之处置）。
5. **赋值与 declaration 合成单元**：顶层/前缀 `variable_assignment`（`FOO=$(rm …)`）与
   `declaration_command`（declare/local/export/readonly/typeset）各自产出合成 ParsedCommand
   （argv 取词面、dynamic 按体内展开节点、injection 按体内 command_substitution——堵审查
   A-P0-3 full 档压制丢失）；**declaration 实参为引号字符串时原文兜底扫描 `$(`/反引号 →
   injection**（`declare -a 'a=($(sudo id))'` 引号内数组 bash 真执行——审查 B-P0-2 实证，
   AST 无节点，保守扫描是唯一闸门）。赋值前缀剥离后**不**标 dynamic（命令本体静态即可裁决，
   §14.4 放宽申报；解释器命令除外——见边界 4）。
6. **ansi_c_string（`$'\x73udo'`）→ dynamic**（bash 实测解码执行；不解码、保守 ask——审查
   A/B-P0 一致）。
7. **管道结构**：pipeline 末位是 shell 解释器且上游是 fetcher → injection net-pipe-shell
   （curl/wget/fetch）/ base64-shell（base64）；判定用 **basename 归一后**的 argv0
   （`/usr/bin/curl x | sh` 不漏——审查 A-P1-3）。
8. **`trap`/`eval`**：字面量载荷 → 递归再解析并入（同边界 4 机制）；动态载荷 → ask。
9. **`sud$((1))o` 类**：argv0 含任何展开/通配部件 → dynamic（auto ask；硬拒不做解码推测）。
10. **stdin 喂入面统一（stdinFed）**：heredoc/here-string/管道非首位/`< <(…)`/xargs-parallel-find
    payload 五形的宿主解释器在 wrappers 剥离后统一判定（裸解释器吃到即执行不可见内容 → opaque；
    包装形 `| timeout 5 sh`、`env VAR=x bash` 同覆盖）——AST 期只标位不裁决，时序倒置堵口。
11. **语句位替换/展开合成单元**：`[[ ]]`/case/for 值位的 `$( )` → 合成注入单元、`$var`/通配 →
    合成 dynamic 单元（词位消费的替换标在命令本体，两层走 walkSubstitution 分层——互不污染）。
12. **重定向目标位展开**：目标词面含展开/ansi_c → 命令落 dynamic（`cmd > $F` 不因目标文本按字面
    归 root 内放行）；`~user/` 形不可静态解析 → 输出面 ask。
13. ~~full 档 dynamic 落穿重定向~~（裁决⑤取代：full 全过唯提权 deny，本条只剩历史处置记录；
    auto 档 dynamic→ask 语义不变）。
14. **非 bash 族 `-c/-e` 字面量不重解析**（python/node 代码非 bash 语法）→ opaque；env 丢弃的
    VAR=x 记赋值前缀（载荷为解释器按环境注入链处理）；trap 动态载荷与 eval 同类注入；语句位
    纯字面赋值（FOO=bar）不产合成单元（空转无执法面）。

### 14.3 改/删映射（文件级）

| 文件 | 处置 |
| --- | --- |
| `bash/segments.ts` | **整文件删**（~137 行词法/组装——全部漏洞的源头） |
| `bash/redirect.ts` | **整文件删**：REDIRECT_RE 正则、`withoutRedirects` 词元剔除 hack、opOf 全由 AST file_redirect 匿名算符子节点取代；`DEV_NULL` 常量与目标裁决逻辑移驻 adjudicate/ast |
| `bash/injection.ts` | 重写瘦身：9 kind → 6 kind——`command-substitution` 吸收 backtick/env-substitution；`fd-substitution` 删（`$<` 实测 hasError→unparseable，同终态）；`net-pipe-shell`/`base64-shell` 管道结构化（basename 归一）；`find-exec`/`xargs-shell` 改 payload 规则（边界 3）；`eval` 并入载荷再解析机制。原文正则 `detectInjection` 删 |
| `bash/hard-deny.ts` | 归一化砍半：引号/反斜杠/级联分支删（词面重构免费给出，次序见 §14.2）；env 前缀剥离迁 ast.ts 包装器表；basename 保留；`netPipeShell` 的 rawText 参数删（管道结构化）；新增 payload 入口（xargs/find -exec 提取词跑同一硬拒） |
| `bash/adjudicate.ts` | 管线裁决序骨架不变；输入形状 Segment → ParsedCommand；重定向双面裁决（边界 2）；unparseable + parser-unavailable → ask；argv=[] 纯重定向单元与赋值/declaration 合成单元进循环 |
| `rules/bash-prefix.ts` | 匹配词列换干净 argv（前缀/裸精确/`*` 万配语义不变） |
| `src/index.ts` | 移除 parseSegments/Segment/ParseResult/detectInjection/redirectsOf/Redirect/DEV_NULL 导出；新增 parseBash/BashParse/ParsedCommand；InjectionKind 保留（审查 A-P1-2——漏此行 typecheck 即红） |
| `decide.ts` / `plugin.ts` | **零改动**（adjudicateBash 同步签名与 BashPipelineInput 不变） |
| `bash/ast.ts` + `bash/wrappers.ts` | **新增**（§14.2——语法层/政策层两文件） |

### 14.4 语义变化清单（双向全申报，逐条有测试背书）

**收紧（修真漏洞）**：§14.0 表 8+1 全形；包装器家族与 payload 面；解释器文件/stdin/赋值前缀/
空载荷；declaration 引号实参兜底扫描；ansi_c；`>|`/`>&`/任意 fd 输出算符入矩阵；`<` 输入面
denyRead deny；无命令纯重定向裁决。

**放宽（修假阳性/摩擦，均有 shell 语义或裁决一致性依据）**：
- `$((1+2))` 非 injection（降级 dynamic 词——auto 仍 ask / full 过；argv0 与重定向目标内
  含算术照旧 dynamic）；
- 单引号/注释内 `$( )` 不再命中（shell 本就不展开——declaration 引号实参例外，见边界 5）；
- 引号定界 heredoc 体纯字面，不再当命令裁决（现行体行假阳性硬拒消失）；
- 引号内 `>` 不再误作重定向目标；
- `FOO=$X git status` 赋值前缀不再拖 dynamic（命令本体静态即可裁决；解释器例外）；
- `ls \| xargs grep foo`、`find . -exec grep foo {} \;`、`eval 'git status'`、`bash -c 'git status'`
  良性形从现行 injection 恒 ask 变为可界内 auto-allow（载荷已再解析/硬拒过筛）。

**裁决序重排明示**（审查 A-P0-6）：现行 injection 在顶层压过一切；新序 injection 为命令级第 3
位（deny 规则、硬拒之后）。终态变化仅一处：injection 命中且 deny 规则命中的命令 ask→deny
（方向更安全，与现行 full 档「deny 规则压过硬拒」同哲学，adjudicate.test.ts 已有先例断言）；
injection 仍压过 full 档与 allow 规则（NEVER_MEMORIZE 不变）。unparseable 与 injection 先后：
现行先答 injection，新序 parse 失败即 unparseable（终态同 ask、reason 变化，§14.5-6 钉）。

### 14.5 边界与异常测试增补（真实异常、区分度钉死，禁假绿）

1. **洞回归×9**（§14.0 逐行，**harness 钉死**：fence 在场 + `Bash(*):allow` + auto 档——旧代码
   此 harness 下全 allow，区分度成立；reason 逐条钉 `hard-deny:sudo`/`hard-deny:rm-rf-root`/
   `injection:command-substitution`/`redirect-read:` 等）：表 8+1 形；heredoc 洞 6 用区分形双钉：
   非引号体 `$(rm -rf /)` → ask（reason 钉 injection——机制锚）+ 引号定界体含 `sudo id` 行 →
   allow（旧=假阳性 ask，新=纯字面——放宽回归）；洞 7 用例用**引号内越根变体**
   `echo "a > /etc/passwd" > f` 界内目标 → allow（旧=ask 假阳性——审查 C-P0-1：原示例新旧同
   输出零区分度）。
2. **包装器矩阵**（it.each 全家族×主形，flag 变体各至少一腿——覆盖率预算见 §14.6）：
   exact/bounded 全表 × `sudo` → ask；未知 flag（`timeout -q`、`env -C`）→ ask（fail-closed）；
   `env -S 'sudo id'` → ask；`time { sudo id; }` 结构残渣 → ask；剥后空 argv（`time (sudo id)`
   实测形）→ ask；恒 ask 表 it.each 全词（source/./ssh/docker/podman/kubectl/osascript/script/
   coproc/strace/ltrace/valgrind 及 `-e/-c` 字符串实参形、`git -c`）；`ls | xargs grep foo` 良性
   → allow；`printf "sudo id" | xargs sh -c` → ask；`find . -exec sudo id \;` → ask；既有
   `env -i` 用例（adjudicate.test.ts:115-120）断言零改动全绿。
3. **解释器与载荷**：`bash -c 'sudo id'` → ask；`bash -c 'git status'` 界内 → allow；
   `bash -c "$x"` / `bash -c`（空）→ ask；`bash -c '<畸形>'` → ask（传染）；`bash x.sh`/
   `bash < x.sh`/`sh <<'EOF'…EOF`/`BASH_ENV=x bash -c ':'`/`echo x | bash`（管道喂入）→ ask；
   `eval 'sudo id'`/`trap 'sudo id' EXIT` → ask；`source /tmp/x.sh` → ask。
4. **放宽回归**（防退回假阳性）：`echo $((1+2))` full→allow / auto 界内→ask；`echo '$(x)'`/
   `# $(sudo id)`/引号 heredoc 界内→allow；`echo "*"`（引号 glob）→ allow；`cat *.log`
   auto→ask / full→allow（glob 机制钉——审查 C-P0-3）；`FOO=$X git status` 界内→allow；
   `echo \$HOME`（转义字面）界内→allow（不误标 dynamic）。
5. **畸形与 fail-closed**：未闭合引号、`if true then`、`<>`、`$<` → ask（reason unparseable）；
   **parser-unavailable**：`parseBashWith(loader)` 真接缝注入抛错装载器 → 全量 ask（reason 钉
   `parser-unavailable`——与 unparseable 可区分，运维定位需要）；**loader 成功但 parse/遍历抛
   异常**（深嵌套假体）→ unparseable 不崩 pre-execute；**未知 kind**：classifyKind 纯函数导出，
   合成 kind → unparseable；**分类闭集穷尽性三锁**：读语法包真实 `node-types.json`——
   (a) createRequire 解析路径（防 worker cwd/hoisting 漂移）；(b) 过滤 3 条 supertype；
   (c) **计数哨兵=59 非空**（防文件路径错/JSON 形变 → 空集恒真——审查 C-P1-4 假绿口子）；
   断言每个可见 kind 恰归一类（表↔switch↔JSON 三锁合一）；**常驻装载冒烟锚**：`parseBash
   ('echo hi')` ok:true（bun.lock 拉坏 prebuild 时给定位性红）。
6. **政策不变量与断言口径**：必不变=adjudicate.test.ts 现行 14 例（verdict/reason 全形状）+
   plugin.test.ts 10 例（审计断言无 reason 文本匹配，实证不受迁移影响）；必变（审查 C-P1-3
   六处点名）=rules.test.ts 的 parseSegments 四块（15-45）整写为 parseBash 断言、backtick/
   fd-substitution 断言（kind 删除/$< → unparseable）、hardDeny 调用形（rawText 参数删、
   env 剥离迁出）、拼接变体链换 parseBash+重构 argv；注入良性负向电池（rules.test.ts:65-72）
   原样保留防过紧回归；**reason 快照 describe**：对裁决管线全 reason 词建快照表（
   hard-deny:\*/injection:\*/dynamic-segment (expansion/glob)/redirect:\*/redirect-read:\*/
   rule:\*/unparseable command/parser-unavailable/wrapper:\*/opaque-code:\*），防实现期词漂移。
7. **输入面双向钉**：`cmd < ~/.ssh/id_rsa` → deny（reason `redirect-read:`）；denyRead 四表项
   it.each；**反向钉** `cmd < /etc/passwd` → 不 deny 不 ask（裁决①口径——将来补越根 ask
   必红）；`3> x` 越根 → ask；`>& f` 越根 → ask；`>&-`/`<&-`/`2>&1` → 不裁决放行。

### 14.6 实施批次

单实现批次（无过渡版本、无双轨）：依赖（permission +tree-sitter^0.22 +tree-sitter-bash^0.23，
bun.lock）+ ast.ts + 管线迁移 + 删 segments/redirect + index.ts 导出换血 + 测试重锚与增补 +
**§7 测试口径同提交更新**（注入 8 形→6 kind、硬拒 15 逃脱→砍半归一化的表述随代码同变），
同一提交（文档先行已随本节）；四门全绿 + 覆盖率只升不降核验。覆盖率预算：基线钉死为
permission stmts 94.63 / branch 89.58 / funcs 93.33 / lines 99.2（审查 C 实测列序）；segments
（~137 行）出分母、ast.ts 进分子，包装器 flag 变体与恒 ask 表 it.each 保分支余量（裁
ionice——罕见价值薄）；分类闭集 59 kind 的 switch 分支由穷尽性测试与合成 kind 用例共同覆盖。

### 14.7 风险

- **grammar kind 漂移**：caret 语义内 minor 升级可能加 kind——穷尽性三锁测试强制归类，升级必红；
- **平台覆盖**：6 平台 prebuilds 之外（BSD 等）走 node-gyp 编译兜底（Bun 拦 postinstall——T9
  矩阵留意）；装载任何失败 → parser-unavailable 全量 ask（fail-closed 有测试+冒烟锚）；
- **打包**：bundler 消费 permission 时需 `--external tree-sitter --external tree-sitter-bash`
  （本仓 build 门现仅 core，不触发；落注防将来踩）；
- **性能**：原生单例 + 单次 parse µs 级；深嵌套遍历 try/catch 兜 RangeError。

### 14.8 用户裁决点（2026-09-18 讨论定案，默认采纳；审查后范围细化）

1. `<` 输入重定向纳管 → **采纳**（denyRead 表 deny、不做越根 ask——§14.2 边界 2 论证；审查
   B-P1-7/P1-8 的表绑定与 .env 落档已并入）；
2. 算术展开 `$((x))` → **采纳**（非 injection、降级 dynamic 词）；
3. 载体 → **原生**（实测 WASM 在 Bun parse 恒败；原生三集成点全绿；=用户钉的版本）；
4. 包装器前缀剥离 → **采纳**（§14.2 边界 3 表；审查补强：未知 flag fail-closed、`env -S`
   恒 ask、payload 空载/解释器 ask、剥后健全性检查、coproc 入恒 ask）。

### 14.9 方案审查处置（2026-09-18 三路并行：A 契约语义 / B 安全 fail-closed / C 测试假绿）

**采纳——织入正文**：A-P0-1（边界 2 无命令纯重定向宿主）｜A-P0-2/B（边界 3 payload 空载规则）
｜A-P0-3（边界 5 赋值/declaration 合成单元）｜A-P0-4=B-P0-3（边界 6 ansi_c dynamic）｜
A-P0-5=C-P0-2=B-P1-5（分类表按真实 62 named/59 可见重取齐；command_name/file_redirect/
算术族补入；command_substitution 双列矛盾消解为「词面部件+永远递归」；穷尽性三锁）｜
A-P0-6（裁决序重排 §14.4 明示）｜B-P0-1（边界 4 解释器家族四规则）｜B-P0-2（边界 5
declaration 引号实参原文兜底扫描）｜B-P0-4（env -S 恒 ask）｜B-P0-5（恒 ask 表扩
「字符串实参代码执行」族）｜A-P1-1/C-P0-1/C-P1-1（14.0 表修正+洞用例 harness/reason/区分形
钉死）｜A-P1-2（index.ts 行）｜A-P1-3（basename 归一明示）｜A-P1-4/B-P1-4（`3>`/`>&` 入
矩阵）｜A-P1-5（赋值前缀放宽申报+解释器例外）｜A-P1-6（放宽清单补全 §14.4）｜A-P1-7/
C-P1-3（reason 口径+必变断言六处清单）｜B-P1-1（coproc）｜B-P1-2（command 非词法子件递归+
剥后空 argv ask）｜B-P1-3（包装器未知 flag → ask）｜B-P1-6（parseBash 整体 try/catch）｜
B-P1-7（denyRead 表钉 DEFAULT_DENY_READ）｜C-P0-3（glob 扫描机制+用例）｜C-P1-2（零改动
范围收敛 adjudicate/plugin 两文件+`>|`/`>&-` 用例）｜C-P1-4（穷尽性哨兵 59+supertype 过滤+
createRequire+it.each 变体/裁 ionice+基线列序钉死）｜C-P1-5（输入面反向钉+全表 it.each+
reason 词钉）｜C-P2 全（reason 快照 describe、两败态可区分、§7 同提交、装载冒烟锚、
classifyKind 纯函数导出、parse 抛异常假体、恒 ask 全词 it.each、`<<-` 用例、sud$((1))o 用例、
良性负向电池保留）｜A-P2-1/P2-2/P2-4/P2-6/P2-7、B-P2 全（转义不重扫、glob 排除引号/~、
find 终止符词内识别、重构→basename 次序、计数口径统一、heredoc tab 形注记、匿名算符子节点、
`> >()` 递归不裁目标、setsid/exec 与 §4 清场语义交叉引用、内层 unparseable 传染）。

**落档（不修，理由）**：
- **`.env` 的 bash argv 实参读面**（B-P1-8）：`cat .env` 在工具面（Read/Grep 规则）与 darwin
  内核面（无 .env 拒读谓词）都不拦，bash argv 实参级路径扫描超出本件范围；规则词表可表达
  用户自配（`Bash(cat .env):deny` 精确形）。
- **git 内联配置/别名链**（B-P1-9）：`git -c alias…`/`git config` 写 .git/config——darwin
  deny-write 带过滤器必杀全写（§13 落档）使 .git 写保护内核不可表达，围栏 writable 含 root；
  与 §13 已载残留同源，不新增。
- **make/npm run/bun run/yarn/pnpm run 不透明配置执行**（B-P1-10 之一）：与现行等价
  auto-allow（非新弱化）；配置写入已被 Write 门控、执行受围栏承载；`git -c` 已入恒 ask（单
  命令内联形可精确识别），配置文件驱动形落档。
- **brace 展开 `{a,b}`**（A-P2-3）：现行与本方案都当字面量（等价盲区、非新弱化），落档。

**驳回**：无（三路全部采纳或落档）。

### 14.10 收口代码审查处置（2026-09-18 两路并行：A 契约对照 / B 安全+假绿——实施收口前）

**采纳——全修复带回归锚（收口回归 describe 14 例 + 分散锚）**：
A/B-P0（herestring 喂解释器零执法｜payload 裸解释器放行 `ls \| xargs sh`｜重定向目标位丢
dynamic/ansi_c（`cmd > $F`、`cmd > $'/etc/passwd'` 真写验证）｜full 档 dynamic 跳过重定向
裁决（无围栏 full 裸放越根写）｜包装器包裹管道末位 shell（`curl x \| timeout 5 sh`——判定时序
倒置）｜`bash < <(…)` procsub 输入面）→ 六洞全堵：stdinFed 统一喂入面（边界 10）、目标位展开
标记（边界 12）、full 落穿（边界 13）。A-P1-1（`[[ ]]`/case/for 语句位替换只递归不标记）→ 边界
11 合成单元 + walkSubstitution 分层（词位消费不产合成单元——deny 压注入的裁决序不被污染）。
A-P1-2（env BASH_ENV 介导链）→ stripEnv 记赋值前缀。A-P1-3（DEV_NULL 导出残留）→ 摘除。
B-P1-1（`~user` 目标不可解析）→ 输出面 ask。B-P1-2（python3.11 管道缺口）→ isInterpreterName
版本后缀正则与旗面判定共用。B-P1-3（删除旧注入锚无等价新锚——假绿）→ `cat x \| xargs sh`/
`xargs bash` 恢复为新锚（opaque 语义）。B-P1-4（-c 动态载荷缺 WIDE 锚）→ 补。A-P2-1（trap
动态与 eval 类别不对称）→ 统一 injection:eval。A-P2-3（parser-unavailable 裁决级 reason 无钉）
→ BashPipelineInput 增 parse 接缝（缺省真 parseBash——decide/plugin 零改动不破）。A-P2-4（`<&-`
无腿）→ 补。A-P2-5（文档 timeout -k 示例自相矛盾）→ 改 -q。A-P2-6（纯字面赋值措辞）→ 边界 14
注记。A-P2-7（full 档 dynamic 与 opaque 次序未定）→ 边界 13 定序 + full 用例。B-P2-1（假树防御
用例区分度不足）→ procsub 目标形改造（删分支即红）。B-P2-3（`xargs -r` 误判未知旗）→ 无实参
短旗集。B-P2-4（trap --/多 -exec 覆盖）→ 补腿。

**核对一致项**（A 路）：分类闭集 59 kind 逐项一致（三锁实测 named 62/supertype 3/可见 59）；边界
1-9 落点一致；裁决序逐位一致；改/删映射除 DEV_NULL 外一致；§14.4/14.5 清单全落；词汇表 6+4 kind
一致；存量政策断言（adjudicate 14 例/plugin 10 例）git diff 零改动。（B 路）：遍历顺序/词面重构
argv 位/裁决序组合/fail-closed 底座/解释器 -c 递归/包装器跳参矩阵实测未发现逃逸。

**落档（未修，理由）**：非 bash 族 `-c` 字面量不重解析（python 代码用 bash 语法重解析无检测价值，
终态同为 ask——边界 14 注记）；`echo \*` 转义字面星误标 dynamic（保守误报方向，与 `\$HOME` 不
误标不对称——落注）；rules.test 旧 `find . -executable true -exec ls` 锚未逐字恢复（等效语义由
「find 无终止符取余词」「空 payload 注入」新锚覆盖）。

### 14.11 用户裁决⑤（2026-09-19）：full 档重定义 + bun 子命令修订

**full = 完全访问**：裁决管线在 full 档短路为「用户 deny 规则 → 提权/密码类（hard-deny:sudo，
即 sudo/doas/su——basename 归一，含包装器剥离、`$()`/payload/`bash -c` 再解析内嵌形）→ 其余全过
（reason `full mode`）」。畸形命令不再保守 ask——仅原始文本命中提权词（\b(sudo|doas|su)\b）才
deny；`needs_network` 在 full 不再路由 ask（域名白名单由代理层承载）。硬拒底线其余形态
（rm-rf-root/force-push/chmod-777）、注入、结构失败、重定向、opaque、dynamic 在 **full 全部不再
拦截**（auto/plan 语义不变）；围栏仍内核执法越根写/网络/拒读表。取代 §14.4/§14.10 中所有
「full 档恒 ask」表述的 full 侧语义。

**bun 子命令修订**（修复 §14.2 边界 4「bun run 落档」承诺的实现漂移）：bun 身兼解释器与包管理器
——已知子命令形（run/test/install/add/remove/update/upgrade/link/unlink/publish/audit/outdated/
pm/init/create/build/deploy/patch）不作文件操作数处理（走正常裁决，auto+围栏零交互——与
make/npm run/yarn 落档口径对齐）；文件形（`bun x.ts`、带路径/脚本扩展名）与 `bun x`（任意包
执行器）照旧 opaque。

### 14.12 用户裁决⑥（2026-09-19）：简化令——wrapper 收敛 + opaque 原则化

**动机**：收口后的 wrappers 层 ~430 行里约 2/3 是「降低 ask 率」的体验优化而非安全必需（围栏
承载执法、硬拒底线与重定向/拒读面才是不可减层）——用户裁决砍掉两块：

1. **bounded-skip 家族收敛**：剥离只剩 env（旗面+赋值剥离、-S → opaque）/nohup/time（容 -p）。
   删 timeout/nice/stdbuf/watch 四个旗面解析器与 setsid/exec/command/builtin exact 剥离（~150 行）。
   其余**已知运行器**（setsid/exec/command/builtin/timeout/nice/stdbuf/watch/coproc/script/
   strace/ltrace/valgrind）不再解析旗面——统一「载荷词含提权词（sudo/doas/su，basename 归一）→
   结构失败类 ask（reason `hard-deny:sudo`，**full 档亦 deny**——裁决⑤提权面保住）；干净 →
   opaque（可被 allow 规则委托，如 `Bash(timeout:*)`）」。代价：`timeout 5 npm test` 等良性形
   auto 档多问一次（allow 规则可救）。
2. **opaque 原则化**：删 OPAQUE_ARGV0 枚举、awk 特例、解释器旗面语义扫描（operand/stdin-flag/
   unknown-flag 区分，~80 行）。替代：**EXECUTORS 词表**（解释器族含 python3.11 正则 + source/. +
   awk/gawk/mawk + ssh/docker/podman/kubectl/osascript）× **一条规则**（argv 超出 argv0 的任何
   实参 / 输入面重定向 / stdinFed / 赋值前缀 → opaque；裸执行器放行；bash 族 `-c/-lc` 字面量
   载荷再解析例外——内容可见即非不透明；bun 子命令例外保留 §14.11）。git -c 内联别名保留
   （实证执行面，B-P0-5）；xargs/parallel/find payload 提取与 eval/trap 载荷再解析保留
   （非本次收敛对象）。auto 档绝大多数终态不变（机制收敛非语义放宽）；`curl x | timeout 5 sh`
   类包装形由运行器 opaque 承接（reason 从 opaque-code:sh 变 opaque-code:timeout）。

§14.2 边界 3 的 bounded-skip 表与边界 4 的四规则矩阵由本节取代（历史处置记录见 §14.10）。
