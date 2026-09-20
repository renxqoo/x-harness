# CLI：x-harness 宿主终端

> 状态：**已核销**（2026-09-19 定稿并实施收口；两轮双路对抗审查（定稿前 + 收口前）
> 问题全部处置，记录见 §7；验收清单 §6 全勾）。
> apps/cli 是 x-harness 的终端宿主 app：全量装配插件世界，提供行式交互 REPL 与
> 非交互 `-p` 两种形态。参考 pi CLI（`/Users/wrr/work/pi`）的功能形态，落在
> x-harness 插件生态的对等物上。本文是装配与接口的裁决表。

## 1. 范围（用户裁决落档）

**用户裁决（2026-09-19，四问四答）**：

1. **功能范围 = 核心生产面**：REPL + `-p` 非交互 + 会话持久化/resume/continue + 全工具装配 +
   permission 交互审批 + thinking/token 用量展示 + `@file` 引用 + 核心 slash 命令。
2. **无 TUI**：不做组件化终端 UI（不引入 pi-tui、不做全屏/raw-mode 编辑器）；行式
   readline 交互 + ANSI 流式打印。
3. **模型接入 = providers.json 多档案**：`~/.x-harness/providers.json` 声明多 provider，
   `/model` 运行时切换、`--list-models` 列出。
4. **默认装配 = 全部无条件**：含 sandbox-local 与 agent-delegation；flag 只做工具白/黑名单减法。
   例外：`--no-session` 略去 jsonl 持久化插件（内存会话语义必然，见 §2.5）。

**明确不处理**（归属落档）：

| 事项 | 归属 |
| --- | --- |
| OAuth 登录、auth 子命令、凭据管理 | 不做——llm 包是纯配置对象，凭据即 providers.json |
| 主题系统、extensions/themes 加载 | 不做——x-harness 无对应插件子系统（skills 已有：packages/skill，见 §2.5） |
| package manager（install/remove/update） | 不做——plugin-manager 是库形态，宿主 CLI 面另行立项 |
| 会话分享 / HTML 导出 / RPC 模式 | 不做——核心面外 |
| 图片 @file 引用 | 不做——session surface 无图片词条；仅文本文件 |
| 项目信任（trust.json） | 不做——CLI 不加载项目本地插件，无信任面 |
| 运行时「always allow」审批 | 做不了——permission 包 GrantsRegistry 未暴露规则写 API；审批只有本次 allow/deny；extraRoot/域名授权由 permission 自动落账 |
| /model 切换保留会话授权/后台任务 | 遗留登记——dispose→sessionDisposed 会 evict grants/杀后台任务/关代理；根治需包层「换 options 不换会话」通道（agent-loop handle.setOptions + 生命周期按续代保留），独立件立项 |
| 多行粘贴、历史编辑增强 | readline 自带行编辑与历史即生产面；bracketed-paste 等 TUI 能力不做 |
| compact 自身的 token 计量 | 口径落档——compact 直调 llmStream 不产生会话事件，token-meter 不含其消耗（/session 显示为会话内事件用量） |

## 2. 外部契约

### 2.1 命令行接口

```
x-harness [flags] [message...] [@file...]
```

| Flag | 语义 | 缺省 |
| --- | --- | --- |
| `-p, --print [message]` | 非交互：执行完初始消息后退出 | 交互（stdin 为 TTY 时） |
| `--mode <text\|json>` | 输出格式；json = stdout JSONL 事件流 | text |
| `-c, --continue` | 恢复 session-dir 中当前 cwd 最近的**主**会话 | 新会话 |
| `-r, --resume` | 列出会话（编号选择）恢复（需交互 UI） | 新会话 |
| `--session <id前缀>` | 按 id 前缀恢复指定会话 | — |
| `--no-session` | 内存会话，不落盘（装配略去持久化插件） | 落盘 |
| `--session-dir <dir>` | 会话存储根 | `~/.x-harness/sessions` |
| `--provider <name>` | 覆盖 providers.json default.provider | — |
| `--model <model>` | 覆盖 default.model | — |
| `--thinking <off\|low\|medium\|high\|max>` | 思考等级 | default.thinking（缺省 off；max=自适应模型无约束思考） |
| `--permission <plan\|auto\|full>` | 权限模式档（docs/EXEC-ENV.md §5：plan=write/bash 全拒；auto=全流程审批；full=完全访问——总括授权三面铺开，docs/PERMISSION-FULL-UNRESTRICTED.md：工具/围栏/网络面，deny 规则与提权硬拒仍压顶）。REPL 与 `-p` 共用；mode 是进程装配事实，不落会话档 | auto |
| `--api-key <key>` | 运行时覆盖**所选 provider** 档案的 apiKey（仅装配期生效；/model 切到其他档案不跟随） | — |
| `--tools <a,b>` | 工具白名单 | 全部注册工具 |
| `--exclude-tools <a,b>` | 工具黑名单（白名单基础上再减） | — |
| `--no-tools` | 禁用全部工具 | — |
| `--system-prompt <text>` | 整体替换系统提示词 | CLI 内置 section + assemble |
| `--append-system-prompt <text>`（可重复） | 追加 section | — |
| `--list-models [search]` | 列 providers.json 模型后退出 | — |
| `--version` / `--help` | 短路退出 | — |

- `--` 之后：`@` 开头进 fileArgs，其余进 messages；stdin 管道内容拼在初始消息最前。
- **互斥校验**（violation → exit 2）：`-r` 与 `-p`（选择 UI 不可用）；`--no-session` 与
  `-c`/`-r`/`--session`（内存会话无恢复语义）；`--no-tools` 与 `--tools`/`--exclude-tools`；
  `--system-prompt` 与 `--append-system-prompt`；`--session` 与 `-c`/`-r`。
  允许组合：`-p` + `-c` / `-p` + `--session`（恢复后跑完退出，无 UI 交互）。
- **退出码**：0 正常；1 运行失败（LLM/agent 错误、审批拒绝导致失败流、沙箱环境缺失等环境
  错误）；2 用法/配置错误。
- 未知 flag → exit 2。env：`X_HARNESS_HOME`（缺省 `~/.x-harness`）覆盖 home 根（注意：不
  影响 agent-delegation 的 agents 目录缺省链——那条链读 `X_HARNESS_AGENTS_DIRS`）。
- 平台矩阵：darwin（Seatbelt）与 linux（bwrap + socat——allowlist 网络档需要）；其余平台
  沙箱 probe fail-closed 拒启（exit 1，属环境错误）。

### 2.2 providers.json 契约

```json
{
  "providers": [
    {
      "name": "glm",
      "protocol": "anthropic",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-...",
      "models": ["glm-4.7", "glm-4.7-flash"],
      "contextWindow": 200000,
      "maxOutputTokens": 8192
    }
  ],
  "default": { "provider": "glm", "model": "glm-4.7", "thinking": "medium" }
}
```

- 位置：`$X_HARNESS_HOME/providers.json`（缺省 `~/.x-harness/providers.json`）。
- 校验（失败 → 中性英文错误 + exit 2，附示例路径）：`name` 非空且唯一；`protocol` ∈
  {anthropic, openai}；`baseUrl` http(s)；`apiKey` 非空；`models` 非空数组；`contextWindow`
  可选正整数（两协议都接受）；`maxOutputTokens` 可选正整数（两协议都接受——请求未显式带
  输出上限时注入，anthropic 侧协议必填兜底链末端 8192）；**封闭模式**：顶层
  （`providers`/`default`）、档案（上述七键）、`default`（`provider`/`model`/`thinking`）各自
  只认闭集键，未知键报 `unknown field`（附 allowed 集）；`default.provider` 必须指向已声明
  provider；`default.model` 必须在该 provider 的 models 内；`default.thinking` ∈ 五级闭集（off/low/medium/high/max）。
  单 provider 且无 default → 缺省取该 provider 首个 model；多 provider 无 default → 报错。
- 文件只读不写；错误信息提示 0600 权限建议。

### 2.3 交互 REPL 契约

- **stdin 单所有权**：进程持单一 readline 实例。REPL prompt、审批 ask、会话/模型编号选择
  共用它——任一等待输入的场景先 `pause()` 主 prompt，结束后恢复；绝不并发两个待决读取。
- 输入：readline 逐行；prompt `> `。空行忽略。
- **运行中输入**：非 slash 文本 → `agent.steer(text)`；slash 命令 → 提示 busy（仅 /quit 与
  Ctrl+C cancel 生效）。所有对已封存会话的 steer/followup 调用一律捕获降级为提示（清理
  窗口内迟到输入不炸 REPL）。
- **退出**：`/quit`；Ctrl+C（running 时 = cancel 当前 turn；idle 时 500ms 内两次 = 退出；
  **审批 ask 挂起时 = 强制关闭 readline 使 ask resolve 为 deny + cancel turn**）；Ctrl+D
  （EOF）。退出 = 完成清理（§2.7）后 `rl.close()` + 显式 `process.exit(code)`。
- **流式渲染**（stdout 追加写）：text 帧原色；thinking 帧 `\x1b[2m…\x1b[0m` dim；text↔thinking
  切换换行；attempt 边界换行。工具行数据源 = `sessionEvent` 总线（tool/call、tool/result
  词条）：`→ <tool> <参数摘要>`、`✓ <tool>` / `✗ <tool> <错误摘要>`。turn 结束一行用量：
  `[turn N] ↑in ↓out · total（provider/model）`。stdout 写失败（EPIPE）→ 触发清理路径退出。
- **审批**（permission broker，同界面服务工具审批与沙箱域名审批）：TTY 时打印
  `allow <tool>? — <reason> [y/N]`，读一行；y/Y = allow，其余（含 EOF）= deny。**stdin 非
  TTY（print 管道场景）= 不读输入，直接 deny + stderr 警告行**；json 模式补 `permission`
  事件行使其可观测。
- **slash 命令表**（闭集）：
  `/help`、`/quit`、`/new`（新会话——生成新唯一 id，旧会话留在档案）、`/model [pattern]`
  （无参 = 编号列出所有 provider 模型选择；带参 = 模糊匹配切换；内存会话下禁用并提示——
  无 archive 无法 resume 重建）、`/thinking [level]`、`/session`（会话 id/事件数/token 用量/
  当前模型）、`/compact [instructions]`（总结折叠 surface）、`/export <path>`（导出事件卷
  副本）、`/resume`（列出主会话选择切换；内存会话下禁用）、`/clear`（清屏 ANSI）。
- **/model 语义与副作用**：`handle.dispose()` → `agentLoopService.resume(id, {agent})`（日志
  续写，header 不变；jsonl 续写校验对同 id 二次打开成立——dispose 先 flush）。**副作用
  落档**：dispose 广播 sessionDisposed → 本会话 extraRoot/域名授权 evict、后台任务两段杀、
  沙箱代理关闭。切换前提示一行。
- **/compact 语义**：统一走 compactionRunner（`@x-harness/compaction` 手动面）——结构化
  checkpoint 摘要（Goal/Progress/Decisions/Next Steps 格式 + 文件账本 read/modified 清单）、
  尾部 ~20k token 原文保留（keepRecentTokens）、无进展护栏（折叠区不含真轮起点时
  no-cut-point = nothing to compact）。摘要面 = 默认档装配期快照：运行期 `/model` 切换
  不改变摘要拨号（装配期事实先例同 maxOutputTokens）。装配即三面全开：水位自动压缩
  （agentPreStep）+ 413 紧急自愈（agentRequestError）+ 手动 /compact。print 模式
  （`-p` 单发）经同一 openWorld 装配，同样在水位与 413 自愈覆盖内。主窗链：
  显式传参 > 默认档 providers.json 声明窗 > 保守兜底 128k（宁早压不撞 413；真实窗由
  servedWindow——413 实测——收敛）。手动压缩的取消信号：Ctrl+C（idle 单击/quit）abort
  在飞压缩持有的当前信号；下一次 /compact 检测到已 abort 则重铸，不被毒化。产出落**一条 user/message**
  （`surfaceOp:{op:"replace"}`）——锚点保护在插件切口层（protectedHead = 锚点后起算，
  与 agent-loop anchorSystem 共用谓词）。带 AbortSignal（REPL Ctrl+C 可取消）；摘要失败/
  截断/空产出按 skip 词表映射 REPL 文案。
- **/export 语义**：先 `store.flush(id)`（turn 收尾的 flush 为异步告警式，idle 后不承诺字节
  已 fsync——拷卷前必须显式屏障），再拷贝落盘卷；`--no-session` 会话从
  内存 `events()` 序列化。目标路径已存在 → 拒绝（exit 语义按 1，防误覆盖）。

### 2.4 print 模式契约

- **text**：stdout 仅输出最终 assistant 消息文本；进度/工具行/审批提示走 stderr。停止原因
  error/aborted → stderr 错误 + exit 1。
- **json**：stdout JSONL，每行 `{type, ...}`：`session`（header）、`stream`（流帧：
  start/chunk {kind,text}/end）、`tool`（工具调用/结果）、`permission`（审批请求与裁决）、
  `usage`（turn 用量）、`error`、`done`（终态，恰好最后一条）。
- 多条位置参数消息顺序逐条 `followup` + `whenIdle`。
- stdout EPIPE（下游关管道）→ 静默停止写 stdout + 走清理路径退出（exit 1）。

### 2.5 装配面（全部无条件，数组序即注册序）

```
sessionPlugin
createJsonlSessionPersistence({ root: sessionDir })        // --no-session 时略去；provide sessionArchive
toolsPlugin
createPermissionPlugin({ root: cwd, mode: --permission 档 })  // 经 fenceKit 透传；缺省 auto（permission 包内落定）
createSandboxPlugin({ root: cwd })                          // inject permission; provide 围栏 execEnv
createReadPlugin({ gate: PathGate(cwd), observed })         // env 走围栏 execEnv（apply 时 tryUse）
createWritePlugin({ gate, observed })                       // read/write 共享同一 gate+observed
createBashPlugin({ gate })                                  // provide backgroundTasks
createGrepPlugin({ gate })
createTaskToolsPlugin()                                     // waitFor backgroundTasks 停靠
tokenMeterPlugin
createLlmRetryPlugin({ providers: 每档案缺省策略, default })
llmPlugin
systemPromptPlugin
agentLoopPlugin
sessionCheckpointPlugin
createAgentDelegationPlugin()                               // agentsDirs 走缺省链；mailbox 缺席=进程内
createSkillPlugin()                                         // skills 目录扫描 + 会话首轮清单注入（docs/SKILL.md）
```

（共 19 个插件（含 cli-permission-broker 审批插件）+ N 个运行时注册的 LLM adapter。）

skill 目录解析：`X_HARNESS_SKILLS_DIRS`（冒号分隔）> 缺省
`[<cwd>/.x-harness/skills, ~/.x-harness/skills]`（同名项目域胜）；清单以
`<system-reminder>` user 消息注入每会话首 turn，skill 正文由模型经 read 工具
按清单内绝对路径自行读取（用户域首读走既有 permission ask）。

裁决与依据：

- **数组序硬约束**：tool-* 的 env 是 apply 时同步 `tryUse(execEnv)`，围栏 execEnv 的提供者
  sandbox 必须排在 tool-* 之前（topo 只管 inject，此处靠数组序；sandbox-local 单测同序
  `[tools, permission, sandbox, …]`）。
- **多 provider 不用适配器插件工厂**：`createAnthropicCompatLlm` 插件名固定
  `llm-anthropic-compat`，多实例重名被 loadPlugins 拒；宿主在 loadPlugins 后用裸
  `createAnthropicCompatAdapter/createOpenaiCompatAdapter({name: 档案名, …})` +
  `llmRuntime.registerAdapter` 直注册（e2e real.ts 同法）。适配器名 = provider 名 =
  `AgentOptions.provider`。`--api-key` 在此折进所选档案的 adapter options。
- **llm-retry 缺省策略**（每 provider 与 default 同值）：`{maxRetries: 3, initialDelayMs: 500,
  maxDelayMs: 30_000, jitterRatio: 0}`（不暴露 CLI flag；瞬时码集走包缺省；jitterRatio 契约
  为整数 [0,1]，取 0 = 确定性退避——单用户进程无惊群面）。
- **sandbox options**：root=cwd，writableExtra/denyReadExtra/protectedPaths/allowedDomains/
  networkOff 全缺省（域名白名单 + 会话授权，ask 经 broker，缺席退化 deny——包契约）。
  probe 失败（无 wrapper / linux 无 socat）= 装配期 throw = 进程 exit 1 + stderr 说明
  （fail-closed，预期行为；平台矩阵见 §2.1）。
- **gate 一致性**：PathGate(cwd) 与围栏 execEnv root=cwd 满足 tool-core 根一致性校验。
- **系统提示词**：基础段归本 app 的 `base-prompt.ts`（`createBasePromptPlugin`——业务内容在上层；内核 `@x-harness/system-prompt` 仅持注册表与 `wellKnown` 锚点词汇表）（section
  `base/core`：身份/守则/环境块；facts=cwd/isGit/platform/shell/date 由宿主探测传入，
  入口归一压换行——注入面收口，date 会话内定格防午夜缓存断裂）；工具守则段由 tool-core
  在 apply 期直接停靠（D3 投稿式）：section `tool/<name>`（锚 wellKnown.baseCore；
  bash 围栏守则在 sandbox env 下才有文本，local 零段）；装配序硬约束 system-prompt
  先于带 guidance 的 tool-*（D6，头注）。`--system-prompt` 整体替换时不装基础段
  （走 AgentOptions.systemPrompt 静态串，优先于 assemble 是包契约）；
  `--append-system-prompt` 追加 section `cli-user-<n>`（无边落尾=全部内置段之后，链式保序）。
- **会话 id 生成（单一来源）**：`mintSessionId`（@x-harness/session）铸 `<UTC时间戳>-<6位随机>`
  形态 id（满足 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，字典序即时间序）；`SessionStore.create`
  缺省铸号即此（跨进程唯一）——CLI 一律走缺省铸号（不传 id），`/new` 亦然。
- **`--no-session` 装配形态**：略去 createJsonlSessionPersistence（无条件装配的唯一例外，
  内存会话语义必然）——后果：sessionArchive 缺席 → `/model`、`/thinking`、`/resume` 禁用
  （提示；三者都走 dispose→resume 重建，内存会话重建即丢上下文），`/export` 走内存序列化，
  `--continue`/`--session` 与其互斥。

### 2.6 会话解析（resolve-session）

优先序：`--no-session` > `--session <前缀>` > `--continue` > `--resume` > 新建。

- **主会话过滤**：`--continue` 候选与 `/resume`、`-r`、`--session` 前缀匹配一律过滤
  `header.agentId === undefined`（delegation 子代理会话同 cwd 落盘，不得当主会话恢复）。
- `--continue`：filter（cwd === process.cwd() ∧ 主会话）中 createdAt 最新；无候选 → 新会话
  （非报错——首次使用是常态）。
- `--session <前缀>`：archive listHeaders 过滤 `id.startsWith(prefix)`；恰一个 → resume；
  多个 → 交互下编号选择（print 模式 exit 2 并列候选）；零个 → exit 2。
- **resume 的模型语义**：`AgentOptions` 显式值在 agent-loop 折叠时**恒胜**会话末次记录——
  因此 resume 路径只传**用户显式 flag**（--provider/--model/--thinking/--api-key 中实际给出
  的，含显式 `--thinking off`），未给的留 undefined，自然回落会话末次 dial；工具面同理：
  无工具 flag 时 resume 不注册 restriction（= 显式全集放开——W2B 勘误：与历史行为等价，原「不放开」表述词不达意）。仅**新建**会话才用
  providers.json default 解析全量。resolve-model 产出因此是两层：`{defaults（新建用）,
  overrides（仅显式 flag，resume 亦用）}`。`--api-key` 绑定 default 解析出的档案
  （apiKeyProvider）；resume 无显式 --provider/--model 时若请求实际发往会话末次 provider，
  覆盖不跟随（绑定口径落档）。
- **resume 的权限模式语义**：`--permission` 不进会话档、不随 resume 继承——按**当次**
  flag 装配（与模型面「显式 flag 恒胜」不同：mode 无会话末次记录可回落）。后果显式落档：
  plan 会话 resume 不带 flag 即回 auto（用户可感知的静默放宽写权限）；full 会话同理回
  auto（界外回归 ask 审批链）。full 档边界（docs/PERMISSION-FULL-UNRESTRICTED.md）：
  总括授权使工具面界外可达、围栏 writable 全盘、网络面代理短路（`full -p` 下未预授权
  域名 CONNECT 直接放行，非 TTY 不再恒 deny）；deny 规则（.git 写拒/拒读表）与提权
  硬拒仍压过 full；darwin 拒读表可被 rename 绕过为已知内核边界（EXEC-ENV §5）。
- **单写者假设与锁**：jsonl writer 无跨进程锁，双进程同开会话会交织写坏（前缀校验只在打开
  瞬间做）——session-persistence-jsonl 包补会话目录锁（`lock` 文件 O_EXCL + pid 活性检测 +
  死锁接管），冲突方 open 即败 `session-locked`，CLI 报错 exit 1。

### 2.7 并发/一致性预算

- 单飞行 turn 由 agent-loop 保证；slash 命令仅 idle 执行。
- stdin 单所有权协议见 §2.3；审批/选择期间主 prompt pause。
- Ctrl+C 双击窗口 500ms；SIGTERM/SIGHUP = cancel + 清理 + 退出。
- stdout EPIPE = 停写 + 清理退出。
- **退出清理顺序**（与 e2e real.ts 同律，所有退出路径统一）：`handle.dispose()`（内含
  cancel→whenIdle→flush→store.dispose；审批 ask 挂起时先强制 resolve deny 再 cancel）→
  `ctx.dispose()`（LIFO 回卷；sessionPlugin 数组首位最后回卷，孤儿会话由各包 sessionDisposed
  监听清理）→ `rl.close()` → `process.exit(code)`（不依赖事件循环自然排空——readline/定时器
  可能挂住进程）。

## 3. 模块划分（apps/cli/src，一动词一文件）

```
main.ts                  入口：解析→短路命令→装配→会话解析→模式分派→退出码
parse-cli-args.ts        参数解析（纯函数，Result 形态）+ usage 文本
providers-file.ts        providers.json 定位/读取/校验（解析纯函数 + IO 薄层）
resolve-model.ts         两层解析：defaults（新建用）+ overrides（仅显式 flag）
harness-home.ts          X_HARNESS_HOME / ~/.x-harness 定位
build-world.ts           装配数组构造（含 --no-session 条件化）+ adapter 直注册 + 服务门面
broker-terminal.ts       permission broker（readline/TTY 探测注入，ask 可被关闭强制 deny）
cli-prompt-sections.ts   系统提示 section/variable 注册（文本纯函数 + 注册薄层）
resolve-session.ts       会话解析（纯逻辑 + archive 注入；主会话过滤/前缀匹配）
pick-session.ts          编号列表选择（readline 注入；与 REPL 共用单实例协议）
process-file-args.ts     @file 展开为 <file name> 文本块（IO + 纯拼接分离）
build-initial-message.ts stdin + files + 首条 message 拼接（纯函数）
render-stream.ts         流帧/工具事件 → 展示行（纯函数，sink 注入）
format-usage.ts          token 数/用量行格式化（纯函数）
run-print-mode.ts        -p 执行器（text/json 两形态；EPIPE 处置）
run-repl.ts              REPL 循环（stdin 单所有权、Ctrl+C 状态机、退出清理；/compact 经 compactionRunner + REPL 文案映射）
slash-commands.ts        slash 命令表 + 分派执行
export-session.ts        /export 实现（flush 屏障 → 拷贝/内存序列化；已存在拒绝）
```

包内改动（随批实施）：`session-persistence-jsonl` 增加会话目录锁（§2.6，含回归用例）。

console 使用豁免：`.oxlintrc.json` no-console override 的 files 加 `apps/cli/**`（终端输出
就是职责）。

## 4. 测试口径（实现前定稿）

- **契约级**：parse-cli-args 表驱动——每 flag 生效/缺省/别名/互斥全错例（含 `-p`+`-c` 合法
  组合）/未知 flag/`--` 分流；providers-file 词表封闭（protocol/thinking 闭集、default 指向
  性、maxOutputTokens 正整数与封闭模式校验）；slash 命令表闭集 = /help 文档列出集；mintSessionId 词表（测试居 @x-harness/session 包）
  与唯一性。
- **边界**：空 providers/坏 JSON/重复 name/default 指向缺席 provider；@file 不存在（exit 2）/
  空文件跳过/BOM 剥离；空 stdin；垃圾 slash 输入（未知命令提示不崩）；print 无 message 且无
  stdin（exit 2）；--no-session 全行为矩阵（/model//resume 禁用、/export 内存序列化、互斥）。
- **表驱动**：resolve-model 两层优先级矩阵（新建 defaults 合成 vs resume 仅 overrides）；
  format-usage（0/999/9.9k/1.2M）；render-stream 帧序列（text/thinking 交错、attempt 边界、
  工具对）→ 期望行数组。
- **集成（进程内）**：build-world 全量装配冒烟（streamFn 假剧本 adapter）——服务可 use、
  工具 schemas 含预期工具、tools 白名单投影、--no-session 条件化装配断言；run-print-mode
  text/json 两形态断言输出行（sink 注入）+ 退出码 + permission 事件行；compact 落账断言
  **+ 回归：compact 后再跑一个 turn，断言摘要仍在 surface、锚点未被覆写**；模型切换
  dispose→resume 续写断言；会话锁：双 open 第二个 `session-locked`。
- **e2e（子进程，进默认门）**：packages/e2e 新增 cli-journey——spawn `bun apps/cli/src/main.ts`：
  (1) print text：@file + 管道 stdin + 假剧本；(2) --list-models/--version/用法错退出码；
  (3) REPL 管道驱动：喂一行 → 断言流式输出 → /quit；(4) resume 续会话（第二次 spawn
  --continue，断言上下文延续）；(5) 双进程同会话锁拒绝。
- **回归**：开发中发现的每个 bug 一条回归用例，用例名注明症状。

覆盖率纪律：渲染/输入/审批全部 sink/readline 注入纯化，进 90/85 门禁（vitest include/
coverage include 扩 `apps/*/src/**`；不接受为凑数排除）。

## 5. 实施批次（施工图）

| 批 | 内容 | 验证 |
| --- | --- | --- |
| A | monorepo 接线（workspaces/tsconfig/oxlint/vitest 扩 apps）+ apps/cli package.json + parse-cli-args + providers-file + resolve-model + harness-home + new-session-id + 单测 | 四门 |
| B | session-persistence-jsonl 会话锁（+回归用例）+ build-world（全量装配 + adapter 直注册 + no-session 条件化）+ broker-terminal + cli-prompt-sections + 装配冒烟单测 | 四门 |
| C | process-file-args + build-initial-message + render-stream + format-usage + run-print-mode（text/json）+ 单测 | 四门 |
| D | resolve-session + pick-session + run-repl + slash-commands + export-session + 单测 | 四门 |
| E | e2e cli-journey 进默认门 + 对抗审查（≥2 并行子 agent：契约对照面/生命周期与清理面/假绿面）+ 处置 + 收口 | check 全绿 |

## 6. 验收清单

- [x] 交互 REPL：流式渲染（text/thinking dim/工具行/用量行）、steer、审批 y/N（含 Ctrl+C
      强制 deny）、Ctrl+C/D 退出（含清理窗口迟到输入不崩）
- [x] -p text：stdout 纯最终文本；exit 0/1/2 语义正确；EPIPE 不崩
- [x] -p --mode json：JSONL 流含 permission 事件，done 恰为末行
- [x] 会话：落盘目录形态、唯一 id 无跨进程撞名、--continue/--resume/--session 前缀（主会话
      过滤）、resume 后上下文延续且模型回落会话末次（无显式 flag 时）、/export（flush 后）
- [x] providers.json：多 provider 注册、/model 切换（副作用提示）、--list-models、default
      缺省链、校验错例全表
- [x] 装配：全量 17 插件 + N adapter，数组序护栏（sandbox 先于 tool-*）、--no-session 条件化
- [x] 工具面：read/write/bash/grep/task_output/task_stop/delegation 工具在册；--tools/-xt/-nt 生效
- [x] 权限：界内 auto allow、ask 经 broker、非 TTY deny+警告、broker 缺席退化 deny 不崩
- [x] thinking 四级、token 用量显示（/session + turn 行，含 resume 冷启动折叠）
- [x] compact：保锚点折叠、fold 后 turn 摘要仍在、abort 可取消
- [x] 会话锁：双进程同会话第二个 session-locked 拒绝
- [x] 四门全绿 + 覆盖率 ≥90/85 如实报告 + e2e 旅程全绿 + 对抗审查清零

## 7. 定稿前对抗审查处置记录（2026-09-19）

两路并行审查（契约对照面 / 生命周期与并发面）发现的问题与处置：

第一轮（方案定稿前）：

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | compact 折叠全部 surface 会毁掉 agent-loop 系统锚点（下一 turn 摘要被覆写机制摧毁） | §2.3 改为保锚点 user/message 折叠 + §4 回归用例 |
| 2 | 会话 id 进程内计数跨进程撞名 → session-id-reused 永久拒写 | §2.5 铸号单一来源（store 缺省 mintSessionId） |
| 3 | --no-session 与无条件装配持久化矛盾；no-session 下 /model /resume 必坏 | §2.5 条件化装配 + 行为矩阵 + 互斥校验 |
| 4 | resume 被 providers.json default 静默改写模型/thinking | §2.6 两层 resolve-model（resume 仅显式 flag） |
| 5 | continue/resume 候选混入 delegation 子代理会话 | §2.6 agentId 过滤 |
| 6 | 互斥清单缺漏（--no-session 组合）、print+--session 死规则 | §2.1 修订（-p 与 -c/--session 放开组合） |
| 7 | 审批 ask 挂起时 Ctrl+C/SIGTERM 全退出路径死锁 | §2.3/§2.7 强制 resolve deny + cancel 契约 |
| 8 | 双进程同会话交织写盘（writer 无锁，前缀校验只防打开瞬间） | §2.6/§3 包内会话锁（O_EXCL+pid 活性+接管） |
| 9 | /model 副作用（grants evict/后台任务杀/代理关）未落档 | §1 遗留登记 + §2.3 切换前提示 |
| 10 | /export 拷到 pending 滞后卷（turn 收尾 flush 为异步，idle 不承诺 fsync 完成） | §2.3 flush 屏障先行 |
| 11 | stdin 双消费者（ask 的 question 与 REPL prompt 竞争） | §2.3 单 readline 所有权协议 |
| 12 | print 管道 stdin 审批静默 EOF→deny | §2.4 非 TTY 显式 deny+警告+json permission 事件 |
| 13 | stdout EPIPE 崩溃绕过清理 | §2.3/§2.4 EPIPE 处置 |
| 14 | 非darwin/linux 与缺 socat linux 的无条件装配后果未落档 | §2.1 平台矩阵 + exit 1 归属 |
| 15 | 退出机制（readline/定时器挂住进程）、清理窗口迟到输入炸 REPL、/export 已存在行为、/compact abort 与用量口径、--api-key 绑定时点、delegation agents 链不吃 X_HARNESS_HOME、插件计数/引用勘误 | §2.3/§2.5/§2.6/§2.7 逐条落档 |

第二轮（代码收口前，2026-09-19；两路：契约/行为对照 + 生命周期/假绿）：

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | json 模式 permission 事件行承诺落空（无订阅） | run-print-mode 订阅 permissionDecided 审计事件输出 permission 行 + 用例 |
| 2 | 交互 `-r` 恒 exit 2（pick 形态被无条件拒绝）；`--session` 歧义前缀交互无选择 | planResumeId 区分交互形态；交互下 pick/歧义走一次性 readline 选择（REPL 接管 stdin 前） |
| 3 | `--no-session` 下 `/thinking` 换级会毁灭会话（兜底新建丢上下文） | /thinking 内存会话禁用 + 矩阵落档 §2.5 |
| 4 | resume 显式 `--thinking off` 被归一丢弃 | overrides 层不做 off 归一（显式 off 恒胜会话末次等级）+ 用例 |
| 5 | resume 恒传全量 tools，上一会话受限名单被静默放开 | 无工具 flag 时 resume 不传 tools + 用例 |
| 6 | 退出路径不 cancel 在飞 turn → /quit/SIGTERM 挂到流自然结束 | quit() 统一 cancel("quitting") + SIGTERM 143 回归用例 |
| 7 | Ctrl+C 挂起审批只 deny 不 cancel turn | cancelPendingQuestion 后补 cancel（§2.3 原文语义兑现） |
| 8 | slash 分派链路零 rejection 捕获（/export 不可写、compact abort 等炸 REPL） | 分派 .then(ok, err) 降级 + exportSession mkdir 捕获 + summarize 流异常归一 |
| 9 | cancelPendingQuestion 留僵尸 readline question（吞用户下一行） | 收束后 resume+write("\n") 结清僵尸回调 + 回归用例 |
| 10 | 锁接管 check-then-act 竞态（败者 unlink 掉胜者活锁） | rename(2) 原子摘除 + wx 重建权威；败者按新持有者活锁判定拒绝 |
| 11 | REPL stdout EPIPE 不触发清理退出 | guardedEpipe + wireQuit 回填触发 quit(1) |
| 12 | /model//resume 切换无 flush 屏障（可切进不可持久化会话）/无并发互斥 | makeNext 后 store.flush 失败即 fatal 退出 + switching 互斥 |
| 13 | run-repl 测试丢弃 replPromise（挂起类 bug 永远测不出） | fixture 保存 promise，/quit/EOF/信号后 await 并断言退出码 |
| 14 | e2e 缺腿：--continue、管道 stdin；pty 双击腿弱断言 | 三腿补齐（--continue 上下文延续 / stdin+@file 组合 / press-again 断言） |
| 15 | compact 单击 Ctrl+C 不取消 | idle 分支顺带 abort compactAbort（幂等） |
| 16 | 文档勘误：插件计数 18（含 broker）、--session 前缀也过滤主会话、退出顺序（close 先于 dispose——ask 挂起强制 deny 语义）、--api-key 绑定口径、usageText 补 -v/-h | 各节同步修订 |
