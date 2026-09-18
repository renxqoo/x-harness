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

**bash 命令裁决管线**（纯函数，表驱动 + 变异角度——对注入/硬拒每形做等价变形生成对抗用例）：
1. **注入检测压过一切 allowlist**（8 形：命令替换/反引号/网络管道入 shell/find -exec/xargs/eval/
   base64 解码入 shell/env 赋值替换 + `$<`）→ ask（reason injection）；
2. **硬拒底线**（`rm -rf /`、`sudo`、`git push --force`、`curl…|sh`、`chmod -R 777` 等 + **15 形
   逃脱矩阵**）→ 恒 ask，**NEVER_MEMORIZE**（会话授权永不记 allow——授权投毒拒绝）；
3. **段解析**（&&/||/;/|/子壳逐段，引号内分隔符不拆，未闭合引号保守 ask，非字面量
   `$var/$(…)/*` → ask）逐段匹配前缀规则；
4. **重定向目标裁决**——算符全矩阵 `>`/`>>`/`2>`/`2>&1`/`&>`/`>/dev/null`（dev/null 属围栏许可，
   裁决 allow）：目标越根/`..` 归一后越根/`~` 展开后越根 → ask（reason redirect）；界内 allow；
5. **围栏事实合成**：段全 allow 且界内（cwd∈writable、无网或网在授权内）→ **auto-allow**。
   `needs_network: true` 声明位（dsh 思想）：声明 → 路由 ask；未声明撞断网 EPERM → 错误文案含
   自行声明指引。

**模式档**（闭集）：`plan`（write/bash 全拒，read/grep 界内 auto）/ `auto`（缺省，全流程）/
`full`（全 allow 除 deny 规则与硬拒底线——仍受围栏，非 unsandboxed）。

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

**权限**：段解析矩阵（复合/引号/未闭合/非字面量）；注入 8 形 + **等价变形变异**；硬拒 15 逃脱形 +
变异 + NEVER_MEMORIZE 投毒；前缀规则精确匹配；**重定向算符全矩阵**（>/>>/2>/2>&1/&/>/dev/null ×
界内/越根/../~ 展开）；**needs_network 声明/未声明双路**；deny 压过 allow 含 full 档；来源覆盖；
拼错规则拒启（apply throw）；三模式档矩阵；broker 缺席 ask→deny；审计事件每裁决一条（次数断言）；
会话授权隔离（A/B 互不借用）+ **sessionDisposed 逐出**（桶关、代理口关）。

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
