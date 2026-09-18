# TOOLBOX：read / write / bash / grep 四工具插件（件 10）

> 状态：已实施（单测全绿 + e2e 四工具旅程；grep 为 rg 硬依赖单路径——裁决与获取形态对照见 §5）
> 级别：中（文件系统/进程副作用、注入面、并发互斥、原子性）
> 包：`packages/toolbox`（@x-harness/toolbox）

## 0. 形态

```ts
export interface ToolboxOptions {
  readonly root?: string;              // 工作区根（缺省 process.cwd()）；相对路径在其下解析，越根拒绝
  readonly defaultTimeoutMs?: number;  // bash 缺省墙钟（缺省 120_000）
  readonly maxTimeoutMs?: number;      // bash timeout_ms 上限（缺省 600_000——防排他屏障被钉死）
  readonly maxOutputBytes?: number;    // bash 输出字节帽（缺省 30_000，截断保尾部）
  readonly spillDir?: string;          // 截断全文落盘目录（缺省 mkdtemp(tmpdir()/x-harness-)，0700）
  readonly rgPath?: string;            // rg 显式路径（解析链最高优先级；缺省 env X_HARNESS_RG_PATH → PATH 探测）
  readonly env?: ExecEnv;              // 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed）
  readonly maxConcurrentTasks?: number; // 每会话后台任务并发帽（缺省 3）
  readonly taskTimeoutMs?: number;     // 后台任务墙钟帽（缺省 600_000——任务生命周期上限，与前台 turn 等待上限解耦）
}
export function createToolbox(options?: ToolboxOptions): {
  readonly readPlugin: Plugin;   // name "tool-read"
  readonly writePlugin: Plugin;  // name "tool-write"
  readonly bashPlugin: Plugin;   // name "tool-bash"
  readonly grepPlugin: Plugin;   // name "tool-grep"
};
// read+write 共享观察登记（需同工厂成对装配）；grep 依赖 rg 二进制（§5 解析链）
```

四个工具经 `toolRegistry.register` 注册（inject ["tools"]）。并发档（交集 35）：read/grep 声明
`isConcurrencySafe: () => true`（parallel）；write/bash 不声明（缺省 exclusive——fail-closed）。

## 1. 路径门（共享，paths.ts——交集 36）

- 相对路径以 `root` 解析；解析后（含 `..`）越出 root → `PATH_ESCAPES_ROOT` 拒绝；
- 绝对路径必须落在 root 内（含 realpath 归一：对已存在最深祖先做 realpath 后再判前缀——symlink
  逃逸防护，DSH 思想）；
- 全部工具入参含 NUL → `NUL_IN_ARGUMENT` 拒绝（my-agent 统一口径）；
- 非 agent 调用方（无 session）：行为不变（门只看路径，不看调用方）。

## 2. read（read.ts）

**Schema**：`{ path: string, offset?: int ≥1（1 起）, limit?: int ≥1（缺省/上限 2000） }`。
非法值（0/负/非整数）→ TypeBox 校验层拒绝（不静默回退第 1 行——交集 4）。

**行为**：
- 逐行流式读取（同步 readSync 逐块 + StringDecoder + 手动行拆——**绝不整读进内存**，pi 整读是
  反面教材；Bun 下比 readline 闭包更可控且避免双开流）；无换行 chunk 行内累计上限 2000 字符
  （超限后续 chunk 丢弃——无 O(n²) 重扫）；
  字节预算 50_000：窗口内先到 2000 行或 50KB 即止（交集 6/7）；
- 行渲染 `N: text`（N 从 1 起连续——交集 1）；CRLF 剥 `\r`；尾换行不产悬空空行；
- 单行超 2000 字符截断 + `… (line truncated to N chars)`（交集 10）；
- 页脚三态：用户 limit 早停 → `Showing lines A-B of T. Use offset=B+1 to read on`（行动型——交集 2）；
  字节封顶 → `Output capped at 50000 bytes. Use offset=N to read on`；EOF 到达 → 无页脚；
- offset 越过 EOF → `OFFSET_BEYOND_EOF: file has M lines` 明确报错（交集 3）；
- 空文件 → `(empty file)` 非错误（交集 8）；
- 缺失 → `FS_NOT_FOUND`；目录 → `FS_NOT_REGULAR_FILE: use grep for directories`（交集 5）；
- 目标非普通文件（目录/FIFO/socket/设备）→ `FS_NOT_REGULAR_FILE`（`!stat.isFile()` 全拒——
  FIFO 会永久阻塞流读）；
- 二进制嗅探：首 8192 字节含 NUL → `FS_BINARY_FILE` 拒读（peek 后以拼合流继续 readline；
  版本登记取 peek 前 stat）；
- 字节预算按 **Buffer.byteLength 渲染后整行计**（含 `N: ` 前缀；中文每字符就是 3 字节）；
  total-lines 统计需数到 EOF（全文件 IO，流式无内存放大——成本落档接受，参考同款）；
- BOM：读取时剥 UTF-8 BOM 展示（write 侧补回——BOM round-trip）；
- EACCES/EPERM → `FS_ACCESS_DENIED`（与「不存在」分开报——行动指引不同）；
- 成功 read（含空文件——`(empty file)` 也是有效观察）登记
  `path → {ino, size, mtimeNs, hadBom}` 观察版本（会话键控；版本元组 stat 于 head peek 前
  fail-closed，hadBom 用 peek 实测值——write CAS 与 BOM 补回共用此登记）。

**不做（落档）**：图片魔数/多模态（ContentBlock 契约只有 text/tool_use）；会话 cwd 集成
（SessionHeader.cwd 字段存在但无宿主写入链——宿主件接入时再挂）。

## 3. write（write.ts）

**Schema**：`{ path: string, content: string }`（空 content 合法——交集 12）。

**行为**：
- 整文件 create-or-overwrite；父目录自动 mkdir -p（交集 11）；回执 `Wrote <path> (N lines)`
  不回显全文；已存在目标非普通文件（目录/FIFO/socket——`!stat.isFile()` 全拒）：目录
  `FS_IS_DIRECTORY`、其余 `FS_NOT_REGULAR_FILE`（rename 原子语义只对常规文件成立）；
- **观察门 + 版本 CAS**（交集 13）：**登记表按会话键控**（`ctx.session ?? "_anon"` →
  Map<path, 版本>；跨会话不可借用观察——防 A 会话 read 给 B 会话的 write 开门；delegation
  父子会话各自独立桶）。目标已存在且本会话未观察过 → `FS_NOT_OBSERVED: read the file before
  overwriting`；已观察但版本不符 → `FS_STALE_VERSION: file changed since read; re-read then
  retry`；新建文件不需要门；
- **版本元组** `{ino, size, mtimeNs}`（statSync bigint——temp+rename 每次换 inode，比较必须含
  ino）；**write 成功后自登记**（rename 后 stat——write→write 连续写不被自己的门拒）；
- **同路径进程内互斥**：每绝对路径 promise-chain（临界区 = stat 复核 → temp → rename → 自登记）；
  跨进程竞态接受落档（无文件锁——DSH 跨进程锁不引入）；
- **原子写**：同目录 temp 文件 + rename（交集 15）——失败不留半截文件与 temp 残留；
  rename 落在 symlink 路径上时替换链接本身不穿透（temp+rename 天然语义，测试锁定）；
- BOM round-trip：登记过「原文件有 BOM」→ 覆盖写自动补回原 BOM；
- 同目录 temp 名唯一（随机后缀）；NUL 拒绝（§1）。

## 4. bash（bash.ts）

**Schema**：`{ command: string, timeout_ms?: int >0（上限 600_000——maxTimeoutMs 可配收紧）,
run_in_background?: boolean }`。
无缺省超时的三参考共识 vs 我仓无宿主看门狗——**有意偏离**：缺省墙钟 120s（可配），文档落档。

**行为**：
- 进程生命周期经 **exec-env**（`env.spawn` 三级解析：工厂参数 > execEnv 服务 > 装配期
  throw——fail-closed；detached 组杀/`settled` 死净观测面/host-exit 清场全在 env 层，
  见 docs/EXEC-ENV.md）；本文件只留两段杀节奏策略：TERM → 无条件等满 5s → KILL
  （绝不依赖 Bun.spawn 的 signal 选项——abort 只杀直接子进程，孙进程存活，实测）；
  信号死亡渲染 128+n（env 层 code null + signal，折算属本层）；
- 工作目录固定 root：**无 workdir 参数（用户裁决）**——`cd sub && cmd` 在 `sh -c` 下语义等价，
  少一个参数面与两个错误码；DSH 需要 workdir 是 fresh-shell 无状态 + UI 终端呈现 cwd，本仓
  无呈现面（command 内容本就可 `cd`，workdir 门是装饰性防护）；
- 退出码入文本 `[exit code: N]` 且**非 isError**（DSH 口径——命令失败是模型可检视的正常结果，
  交集 16 的口径裁决）；静默命令 `(no output)`（交集 17）；
- 超时：SIGTERM → **无条件等满 5s** → SIGKILL（组长先退≠组清空——不提前取消 KILL）；文本
  `[timed out after Nms]` + 尾部输出 + `raise timeout_ms and retry` 指引；trap 后 exit 0 不得伪装
  成功（超时标记在 exit 标记之前——归因靠「我发起过击杀」标志而非退出码——D23）；工具
  description 教模型「长命令（构建/安装）显式传 timeout_ms」；
- abort（ctx.signal）：同两段杀；pre-abort（执行前已断）由 dispatch 管线入口拦截——工具
  零执行零 spawn（D28；abort 结果归一为管线单一职责）；
- 输出：**双流全程并发消费**（只读一边另一边写满 64KB 管道即死锁假挂；截断/spill 失败后同样
  持续读到 EOF 丢弃——防子进程堵管假挂）；stderr 段 `[stderr]` 前缀分节（补换行）；ANSI 转义与
  裸 `\r` 清洗（P21）；跨 chunk 撕裂 UTF-8 用 StringDecoder（P15）；
- 截断保尾部（交集 20）：30_000 字节 / 2000 行（尾换行不多算一行——P14）先到即截，头部标注
  `[output truncated; full output: <spill 路径>]`，全文写 spill 文件（固定前缀+随机名——**不含
  command/path 任何用户成分**；`wx` 0600；全文累积上限 64MB）；字节帽取尾为**字节精确**
  （Buffer subarray + UTF-8 续字节前移到字符边界——多字节密集输出不撕裂且必有推进）；
  spill 失败 → `(full output unavailable)` 不失败；
- spawn 同步 throw（如 ENOENT）兜底 catch → `SPAWN_FAILED`；命令含 NUL 拒绝；env 不透传模型
  注入面（named spawn 选项，无 shell 二次展开——交集 25）。

**后台任务（run_in_background: true，tasks.ts——BackgroundTasks 登记簿）**：

- spawn 同前台（env.spawn，argv/围栏/裁决不变——permission 对 command 的裁决与前台同管线），
  **不等待**：立返 `Background task <id> started`（id 形如 `t-<hex>`；回执不含输出）；
- 登记簿**会话键控**（`ctx.session ?? "_anon"`——A 会话不可读/停 B 的任务）；每会话并发帽
  （缺省 3，超限 `TASK_LIMIT` 拒绝并指引等待/停旧）；
- 状态机 `running → completed | failed | killed | timed-out`：墙钟帽（缺省 600s）到点两段杀
  （TERM→5s→KILL，同前台节奏）→ `timed-out`；`stop()` 幂等（已终态返回当前快照）→ `killed`；
  退出码 0/非 0 → completed/failed（信号死折算 128+n，同前台）；
- 输出：双流**按到达序并流**进单缓冲（单字节偏移增量读——`read(session, id, offset)` 返回
  切片 + nextOffset + more；伪 offset 回退到字符首字节（不跳数据）、非有限 offset 归 0、
  ANSI/裸 \r 清洗与前台同口径；`[stderr]` 分节是前台语义，后台不保留）；**保留帽 spill**
  触发口径=fullCapBytes（缺省 64MB 可配）超帽停累积并 spill 已保留部分（前台是 30KB 展示
  截断触发——各自口径）；pumps 全 EOF 后才 finalize（bytes/终态/spill 不缺尾）；
- 清场与登记生命周期：sessionDisposed → 该会话任务两段杀并**清桶逐出**（会话生命周期即
  登记生命周期——终态任务保留到会话终结，供 task_output 轮询，无跨会话累积）；装配 dispose →
  全部**直接 KILL**（收尾窗口不留给 teardown——env 层兜底）；host-exit 由 env 进程登记覆盖；
  **单装配假设**：一工厂一装配（同工厂多处 apply 共享登记簿，teardown 互杀不支持）；
  并发帽含在途 spawn 占位（检查与登记隔 await——防 TOCTOU 越帽）；
- **读/停的模型侧动词不建 bash 专属工具（用户裁决）**——未来通用任务层出 `task_output`/
  `task_stop`（跨任务源），本登记簿经 `createToolbox().tasks` 句柄供给。

**不做（落档）**：流式 progress 转发（无消费面）；受信 env 注入；60s 无输出
hung-kill（缺省墙钟已兜底挂死——有意以墙钟替代双时间线，简化）；KILL 宽限可配（5s 常数与
排他档防钉死绑死）。

## 5. grep（grep.ts）

**Schema**：`{ pattern: string（非空）, path?: string（缺省 root）, glob?: string（单正向 glob，
拒绝 `!`/逗号——D38）, literal?: boolean, ignore_case?: boolean, context?: int 0-5, limit?: int
（缺省 100，上限 1000——A31 口径） }`。

**rg 硬依赖（用户裁决：删 walker 兜底）**：grep 只有 ripgrep 一条路径。参考系对照——DSH 库层
`@vscode/ripgrep`（npm install 时 postinstall 下载，装时网络 + 浮动信任，bun 还需
trustedDependencies 开口；其 pkg 发行形态实为 `<exe>-rg` sidecar）；pi 运行时懒下载 latest
（CHANGELOG 病历：GitHub API 配额枯竭、musl 资产修复、下载超时崩溃，且无 sha256 校验）。
本仓形态是内部部署、制品可控：**二进制随制品/镜像携带，agent 运行时零网络**；rg 缺席 =
配置错误 → fail-closed 报错带修复指引，**绝不静默降级**（JS 回退会把 ReDoS 暴露与百倍
性能崖藏进生产路径，且双路径对齐是永久维护税）。触发条件落档：未来若发公开裸 CLI
（匿名用户首次运行、无制品层），获取模型切换为运行时下载（pi 式）是独立产品裁决。

**rg 解析链**（单一顺序）：`ToolboxOptions.rgPath` 显式 → env `X_HARNESS_RG_PATH` →
PATH 探测（`Bun.which("rg")`）。全失败 → `SEARCH_RG_UNAVAILABLE` + 三条修复指引
（安装 rg：`brew install ripgrep` / `apt install ripgrep`；设 `X_HARNESS_RG_PATH`；
`createToolbox({ rgPath })`）。显式给出但不可执行 → spawn 失败归
`SEARCH_FAILED: failed to start rg`（附同款指引）。

**执行**：纯 argv 向量（无 shell 层）：`rg --json --no-config --no-messages --hidden --no-ignore
[skip globs] [--fixed-strings] [-i] [-g glob] [-C N] --regexp=<pattern> -- <path>`
（`--no-config` 防 RIPGREP_CONFIG_PATH `--pre` 注入——D37；pattern 在 `--regexp=`、path 在
`--` 后——flag-like pattern 惰性——P23；**不用 `-m`**——那是 per-file 上限与全局 limit 语义
相悖）。**跳过集**（`--glob !node_modules --glob !.git`；rg 默认不跟 symlink；不尊重
gitignore——`--no-ignore`，声明即可）。
退出码：0=命中、1=零命中成功 `No matches found`（交集 27）、2 → `SEARCH_FAILED` 透传 stderr
尾部（路径缺失与坏正则同为 2——仅 stderr 含正则解析特征时附 literal 提示）、其他 → 若
**selfKilled**（我方达限 kill——退出码 128+SIGTERM）→ 成功终态走 limit 页脚，否则 `SEARCH_FAILED`。
malformed 完整行 → 整体失败（D34）。kill 落点之后的未解析输出（同 chunk 余行、撕裂半行）
直接丢弃——已解析行即终态，不做 kill 后排空（三路终态下排空结果均不可达：达限被
reached 排除、abort/rawOverflow 被 settle 优先归一）。达 limit 即 kill rg（P22 提前停）。
abort → kill（交集 34）。
`--json` 事件形态：begin（path）→ match（path.text/line_number/lines.text/submatches）→
context（同构，submatches 恒空）→ end → summary；输出由事件组装。

**输出**：`Found N matches` + `path:line:text`（单文件也带文件名——P24）；
上下文行 `path-line-text`（grep -C 惯例——交集 29）；行超 500 字符截断 + ` (line truncated, use
read for full line)`（交集 31）；达 limit → `Found N matches (limit M reached). Use limit=K for
more, or refine the pattern`（交集 30——计满即停，不补尾 context）；rg 原始 stdout 超
1MB → `SEARCH_RAW_OUTPUT_OVERFLOW`（D41）。glob 校验 brace-aware：顶层逗号拒、负向 `!` 拒、
`*.{ts,tsx}` 放行（D38）。limit/offset 超上限 → 校验层拒绝（与非法值同口径——与参考的钳制有意不同）。

**不做（落档）**：rg 获取（安装/下载/sidecar 拼装全归制品与宿主层——解析链只负责找）；
respect .gitignore（`--no-ignore` 声明）；多 glob/负向 glob；Windows target（整仓 POSIX-only）。

## 6. 测试口径（交集 38 条逐条 + 回归源）

- read（10）：行号连续/窗口页脚行动型/越 EOF 报错/非法参数（含 limit>2000）TypeBox 拒/
  NOT_FOUND+目录引导/2000 行帽/**50KB 字节帽双断言**（<2000 行且 >50KB ASCII → 字节截；
  300 行×100 中文字符=90KB → 截在完整行边界不撕裂多字节）/空文件/超长行截断/CRLF+尾换行+
  二进制拒/FIFO 非 isFile 拒。
- write（6+回归）：创建/覆盖/回执/空 content/观察门三态（未读拒/读后过/**陈旧拒+重读成功闭环**
  ——utimes 显式构造陈旧）/write→write 连续写（自登记）/跨会话隔离（A 读不给 B 写开门）/
  原子性回归（写中途失败无半截+无 temp 残留）+ symlink 不穿透（rename 替换链接本身）+
  同路径并发串行化（进程内互斥——双写可序列化）/BOM round-trip 补回/空文件 read 开门/
  EACCES → FS_ACCESS_DENIED/FIFO 双拒/atomicWrite 注入（短写循环续写 + 中途抛错原文完好）。
- bash 后台（tasks.test.ts）：立返 id 不等待/状态机五态（completed/failed/killed/timed-out）/
  增量读字节偏移与多字节边界/并发帽 TASK_LIMIT/墙钟帽自动杀/stop 幂等/会话隔离（A 不可读停 B）/
  sessionDisposed 清场与 dispose 直接 KILL（marker 法无孤儿）；
- bash（11+回归）：退出码可见且非 isError/静默 (no output)/超时两段杀（**无条件等满宽限**）+
  标记顺序+尾部输出+raise 指引/trap-exit-0 不伪装（回归 D23）/timeout 校验表（0/负/超 maxTimeoutMs）
  /截断保尾部**三件套断言**（标注在场+尾部内容在场+spill 字节级等于全文）/行帽（尾换行不算行）/
  ANSI+撕裂 UTF-8/spawn 失败兜底/**abort 杀整组**（`process.kill(-pid,0)`
  组探活断言——回归进程泄漏）/pre-abort 零 spawn（marker 文件副作用断言——回归 D28）/
  **host-exit 清场**（子进程杀后父进程退出→ detached 组死净——墙钟验证）。
- grep（rg 单路径）：零命中成功/退出码矩阵（含 **selfKilled→成功+limit 页脚**——回归 A-P0）/argv
  惰性矩阵（`$(rm)`/反引号/换行均无副作用文件——回归 P23/D36）+ **argv 矩阵真 spawn 取证**
  （假 rg 吐 stderr：--json/--no-config/--no-messages/--hidden/--no-ignore/跳过集/--regexp 惰性/
  `--` 分隔全在场）/literal 逃生/ignore_case/glob（brace 放行；顶层逗号拒与负向 `!` 拒——rg 无关
  契约不随 rg skip）/上下文行格式/500 字符截断/limit 提示/**2MB 大文件流式命中 tripwire**/
  abort（管线归一口径）/binary 目录搜索跳过/**分歧面 fixture**（node_modules 跳过、隐藏文件搜到、
  真 .gitignore 不生效、越根 symlink 不跟——越根外目录存活到 afterEach 非 dangling）/
  **rg 缺席时真 rg 用例显式 skip 并计数汇报**（不静默消失）；**解析链**：rgPath 显式 >
  env `X_HARNESS_RG_PATH` > PATH（真 dispatch 双向验证：显式胜 env、env 生效）；
  全缺席 → `SEARCH_RG_UNAVAILABLE` 带三条修复指引（回归：缺席曾静默落 JS 兜底产出弱化
  结果——子进程剥 PATH 构造真缺席 + resolveRg 注入单测双覆盖）；显式 rgPath 不可执行 →
  failed to start rg 带指引；**假 rg 注入装置（rgPath 指向脚本）**：
  malformed/RAW_OVERFLOW/中途 abort/exit 2+literal 提示/argv 矩阵——确定性装置；
  parseRgLine/settleRg 纯函数单测。
- 路径门：越根 `..`/绝对路径越根/symlink 逃逸（回归 my-agent BUG-06）/NUL 拒绝/root="/"
  前缀不拼 `//`（一切绝对路径在根内）。
- 横切：并发档声明（read/grep parallel、write/bash exclusive）/非 agent 调用方可用。
- e2e（默认门加旅程）：write→read 回环 + bash 真命令 + grep 命中，四工具经真实 agent turn 驱动。

## 7. 不处理（归属）

图片/多模态（ContentBlock 契约扩展时）；sandbox/审批流（安全产品线）；通用任务动词
task_output/task_stop（未来任务件——跨任务源消费 tasks 句柄，不建 bash 专属工具，用户裁决）；
流式 progress（观察面消费方出现时）；会话 cwd（宿主件写入 SessionHeader.cwd 后挂——届时
bash 已固定 root 无 workdir）；exit 标记 round-trip（UI 状态面出现时）；TOCTOU 窗口（门 check 与 I/O 之间
换 symlink——接受，防护归安全产品线）；**rg 获取全链**（安装/下载/sidecar 拼装归制品与
宿主层——安装时下载与运行时下载的形态对照及不采纳理由见 §5）；跨进程文件锁（CAS 限同进程）；
spill 清理（保留为恢复产物；宿主可清）；**POSIX-only**（/bin/sh、负 pid 组杀——Windows 不支持）；
解析链信任前提（env 与 PATH 探测的目录不可写——rgPath/env 显式指定是逃生口）；resume 后观察
登记清零（fail-closed：续写后首笔覆盖写需重读——落档）；两层截断方向相反（内层字节保尾/外层
字符保头）——有意设计勿「对齐」；成对装配 fail-closed（漏装 readPlugin → 覆盖写全拒，新建不受影响）。

## 9. 方案审查处置（A/B 两路并行——A 含 Bun/rg 实测）

采纳（A）：rg selfKilled 单列成功终态+去 -m+kill 后排空+撕裂半行记截断（P0——触顶搜索整体
坏死）；host-exit 清场登记簿（P1——detached 孤儿组是进程泄漏）；同路径进程内互斥（P1）；
write 后自登记（P1——连续写被自己的门拒）；版本元组升 {ino,size,mtimeNs} bigint（P3）；
read !isFile 全拒（P3——FIFO 阻塞）；Bun.spawn signal 选项禁用（实测只杀直接子进程）+无条件
等满宽限；双流全程并发消费；workdir stat 预检（后随 workdir 参数删除一并移除）；rg --hidden --no-ignore --no-messages 对齐 +
共享跳过集；exit 2 合并话术；spill mkdtemp 0700+wx 0600+随机名+体量上限；maxTimeoutMs 帽。
采纳（B）：观察门会话键控（P0——跨会话开门）；前缀判定路径段边界；路径门参数清单含 workdir
（裁决过门）；双路径对齐 fixture 三类分歧面；rg 缺席显式 skip 计数；50KB 双断言措辞根治
（Buffer.byteLength 渲染后口径）；brace-aware glob；错误码前缀契约统一；spill 名无用户成分；
三件套断言；组探活+marker 装置；utimes 构造陈旧；limit 超限拒绝口径；realpath 判定与词法 I/O
分离（与 DSH 穿透写有意相反）。

实施期两轮代码审处置（源码级根治，全部带回归用例）：

- bash 输出帽取尾改字节精确（Buffer subarray + 续字节边界前移）——字符数切片对 ≥3 字节/字符
  的超帽输出是无进展空转（死循环 99% CPU）；emoji 回归用例锁定
- bash 组长退出≠组清空：KILL 升级定时器与活组除名改由组探活（`kill(-pid,0)` 有界轮询）门控——
  孙进程孤儿泄漏（真墙钟回归）；ANSI 清洗锚定 ESC（普通 `[INFO]` 文本不被啃噬）
- read 观察登记链：版本元组 stat 于 peek 前（fail-closed）+ hadBom 用 peek 实测值回填（BOM
  round-trip 补回失效根因）；空文件 read 同样登记（覆写被 FS_NOT_OBSERVED 拒的根因）
- grep malformed 完整行 fail-closed 为 SEARCH_FAILED（静默跳过会产出假「零命中」）；撕裂半行
  （无尾换行）记截断不记损坏；walker 自身命中行不因 context 重叠降级（与 rg 对齐）
- grep/read/write/bash 工具层 pre-abort 检查删除——dispatch 管线入口已拦（同一事实一套实现）；
  walker 同步路径的死 abort 检查点同删
- PathGate root="/" 段边界前缀不拼 `//`；read EACCES/EPERM → FS_ACCESS_DENIED（与不存在分报）；
  write 非常规文件（FIFO/socket）`!isFile` 全拒

后台任务批裁决（用户裁决，两轮）：

- 长任务正解 = run_in_background 后台化（前台墙钟维持 120s——排他档防钉死；前台超时文案补
  run_in_background 指引）；后台墙钟帽与前台等待上限语义解耦（缺省 600s 可配）
- **不建 bash 专属 job 读/停工具**——通用任务动词 task_output/task_stop 归未来任务件（跨任务源
  消费 `createToolbox().tasks` 句柄）；登记簿先落地：会话键控/五态状态机/字节偏移增量读（伪
  offset 回退到字符首字节，不跳数据）/每会话并发帽/两段杀节奏与前台同款/dispose 直接 KILL
- ChannelCollector/pump/writeSpill 抽 collect.ts（前台与后台共用——单源）

## 8. 验收清单

- [x] §1–§6 逐条；单测 82 例全绿（paths 8 / read-write 22 / bash 15 / grep 25 / tasks 12——
  含假 rg 注入装置、解析链子进程装置与后台登记簿套件）；e2e 旅程绿（rg 缺席 fail-fast 探针 +
  write→read→覆写→bash→未观察拒→grep→后台立返 七步经真实 agent turn + 盘上副作用与登记簿
  终态断言）；已知覆盖盲区如实落档：grep 的
  `SEARCH_RG_UNAVAILABLE` 分支仅在子进程内可达（v8 覆盖率不可见——行为由子进程用例背书，
  同 worker/host.ts 先例）；四门与覆盖率数字以流水线汇报为准
