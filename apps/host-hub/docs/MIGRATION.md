# host-hub 迁移规格（MIGRATION）

> 状态：定稿（两轮并行对抗审查 6H/26M/22L 全处置；实施中）
> 状态流转：草稿 → 定稿 → 实施中 → 已核销（§8 全勾）
> 迁移单元：多会话宿主整体（my-agent host-hub → x-harness apps/host-hub）
> 旧实现：/Users/wrr/work/my-agent/packages/host-hub（src 50 生产文件 ≈6.4k 行 +
> __test__ 40 文件 ≈4.7k 行 + test/ 进程件 ≈1.0k 行；自带已核销文档族）
> [DESIGN.md](DESIGN.md) 持命令语义（单一事实）；本文持差异、替换表、矩阵与基线。

## 1. 行为规格基线

**等价判定标准** = 迁移源代码 + 迁移源测试锁定的行为（源仓文档为索引——多处滞后
于代码，以代码为准；本仓两轮审查已对账：源文档 lag 清单 = subagent/steer 字段
agentId、thread/retire 在飞 `thread not live`、get_thinking_level "unset" 值域、
set_session_name 无 data、stillDisabled by 恒 "user"、bash-outputs 7 天保留），
minus 迁移源已声明的不移植域，minus 本仓声明差异（§4 + §6），plus 本仓内核加法
（IMPLEMENTATION §3）。

**迁移源自身也是一次迁移**（pai-cli → my-agent）：其 21 项 bug 修复、六轮评审处置、
实施期 6 项真实缺陷修法已内嵌于源代码——**继承代码即继承修法**；对抗审查对照面 =
迁移源代码行为。

## 2. API 替换表（旧 @my-agent/* → 新 @x-harness/*）

### 2.1 装配与会话

| 旧 | 新 | 差异处置 |
| --- | --- | --- |
| `createAgent({providers, model, plugins, settings, session:{dir, resumeId, cwd}})` | `createAgentWorld({plugins})` + `loop.create({session:{id?, cwd?}, agent:{provider, model, thinking?}})` / `loop.resume({id, agent})` | world 装配一次/worker；会话经 loop 服务；resume 需要 archive（durableSessionKit） |
| `agent.send(text, {images})` | `agent.followup(text)` | 无命令路由/skill 展开/多模态面——/compact hub 侧拦截、其余斜杠交模型、images 拒绝（§4） |
| `agent.loop.steer/followup(userMessage)` | `agent.steer(text)` / `agent.followup(text)` | 纯文本；消费时机同构（step0 claim nextTurn 头 + 全部 nextStep；后续 step claim nextStep） |
| `agent.loop.cancel()` + `manager.cancelAll()` | `agent.cancel(cause)` + delegationView.stopAll(cause) | 子代理级联经服务面 |
| `agent.session.append(event)` + `flush()` | `session.append(type, data, intent?)` + `store.flush(id)` | 类型化封闭词表；直写后 flush 纪律不变；fork 前 flush |
| `session.eventList()` / `deriveMessages()` / `writeTip()` | `session.events()` / `deriveMessages()` / `events().length-1` | seq 0 基 = 数组下标 = WAL 行号 |
| `SessionStore.open(id,"read"\|"write")` | `store.get(id)` / `archive.read(id)` | 写侧 get 仅本 world；跨进程读走 archive |
| `SessionStore.fork(sourceId, upToSeq)` | `store.fork(source, {untilSeq, id})` | **返回已打开会话（持写锁）——取 id 后立即 dispose**；untilSeq 为含端切点 |
| `SessionStore.list/summarize/ancestors/subtree/remove/reindex` | `archive.listHeaders()` + hub 折叠 | list_saved/get_tree 谱系 = hub 实现（§4）；remove 无面（挂账 §6） |
| `session_meta{key}` / `modelChangeEvent` / `foldSessionMeta` | **内核加法 `session/meta` 事件** + hub `meta-fold` | 单一 KV 通道服务 title/dial/thinking/permission-mode；dial 改经 agentRequest waterfall（内核自动记 request/context） |
| `isSafeSessionId`（core） | `isSafeSessionId`（core/session 同名同语义） | 直接替换 hub 自写围栏正则（收敛单源） |

### 2.2 事件与流

| 旧 | 新 | 差异处置 |
| --- | --- | --- |
| `agent.emits.on(name)`（21 词表 EmitPayload） | `ctx.on(sessionEvent)`（session 域 18+1 条镜像 WAL）+ `ctx.on(agentAssistantStream/agentStatus/agentError/compactionLanded/...)`（实时域） | 事件帧 name = 内核 token 原名；payload 逐字转发（DESIGN §4 词表） |
| `assistant/stream` ChatDelta 12 变体（done = 权威终局） | `agent/assistant-stream`（chunk 仅 text/thinking）+ **hub 合成域 `llm/chunk`**（llm/stream waterfall tap 转发全量 LlmChunk：tool-call-delta/usage/finish） | **权威终局改 `assistant/message` WAL 事件**；工具增量/usage/finish 经 llm/chunk |
| `inbox_spliced {queue, op, ids, messages?}` | `agent/inbox/spliced` InboxSpliceData（insert 携 entries 本体/claim/clear） | queue 读口 = `foldInbox`（agent-loop 公共导出）——host/worker 共用；**inbox-full 文案退役（内核无容量面）** |
| `turn/end {turnId, reason: string}` | `turn/end` session 事件 `{turn, reason: TurnEndReason 判别联合}` | reason 形状升级——settled ok 判据 = reason.kind ∈ {error, blocked} → ok:false |
| agents 域七事件（manager.observeAll） | delegation 无事件面——delegationView 轮询 + 通知注入（user/message） | **子代理实时事件面退役**（挂账 §6）；在飞状态经 get_subagents/agent/status |

### 2.3 能力面

| 旧 | 新 | 差异处置 |
| --- | --- | --- |
| `compactionRunner.compact({messages, keepRecentTokens, signal, session, trigger, customInstructions})` 事件差分检测 | `compactionRunner.compact({session, trigger, customInstructions, keepRecentTokens, signal})` → `CompactionResult` | 返回面原生（replacedNodes/summaryTokens）；summary 文本经 `previousSummaryOf(session.surface())` |
| `createPermissionAskPlugin(handler)`（AskFields 三字段） | worker 提供 `permissionBroker` 服务（`ask(input: AskRequest): Promise<"allow"\|"deny">`） | AskRequest {tool, reason, session} 两展示字段；confirm 弹窗恒在（mode 作用域 = 工具裁决面 + grants 授权面） |
| `createPermissionPlugin({mode, modeController})` | 内核加法：插件恒提供 `permissionMode` 服务 `{get, set}` + `GrantsRegistry.setUnrestricted(enabled)` | 词表 plan\|auto\|full（源 plan\|default\|acceptEdits\|fullAuto——§4）；set 原子切 decide 面 + 授权面（源 controller 仅 decide 面——升级，§4） |
| `manager.list()/deliverUser/observeAll`（子代理管理面） | **内核加法 `delegationView` 服务**：list()/message()/stopAll() | 直调服务面——不经工具 dispatch（permission ask 墙）与 ChildView 文本解析（§4 形状差异） |
| `loadAgentTypes({dirs})`/`defaultUserTypes`/`projectTypeDir` | **内核加法 barrel 导出** `loadAgentTypes(dirs)`/`resolveAgentDirs(configured)`（agent-delegation types-loader） | 目录约定 ~/.x-harness/agents、<cwd>/.x-harness/agents；trusted 门禁 hub 侧选目录 |
| `createSkillsPlugin({projectSkills, workspace, disabled, settings})` + `skills()` | `createSkillPlugin({skillsDirs, disabled?})`（**disabled 为本仓加法**） + `loadSkills(dirs)` | 目录约定同上；清单/快照同滤 |
| `parseCommandInput`（内核命令词法） | 无对应——hub 只拦 `/compact` | 其余斜杠交模型（§4） |
| `resolveModelFromEvents` | hub `meta-fold`（session/meta dial 尾值 → request/header 尾值 → 装配缺省） | dial 事实源升级（meta 显式 + header 隐式双源） |
| `createFauxProvider` + `HUB_FAUX_SCRIPT` | hub `script-adapter` + `HUB_WORKER_PROVIDER=script` + `HUB_WORKER_SCRIPT` | JSON 剧本内联同构；错误步 {code, retryable} 映射 error-finish |
| provider-pi presets / models.json / modelOverrides / apiKeyEnv | hub catalog：内置预设 + providers.json 超集 + modelOverrides + credentials 叠加 | 形状差异 §4；worker 经 HUB_WORKER_PROVIDERS 装配快照（不读文件）；adapter.name = 档案名 |
| plugin-workspace `resolveShell/spawnShell/killProcessTree/twoStageKill` | bash-exec 自实现（Bun.spawn detached 进程组 + SIGTERM 2s→SIGKILL） | 同语义自持实现 |
| `SettingsRecord` / `createSettingsReader` / `projectDataDirName` | hub-settings 双级（用户 `<agentDir>/hub-settings.json`、项目 `<cwd>/.x-harness/hub-settings.json`） | 项目目录名恒 `.x-harness`（无自定义 token 面——挂账 §6） |

## 3. 帧与协议差异（wire 面）

| 旧 | 新 |
| --- | --- |
| hello `{protocolVersion:1, backendId:"my-agent"}` | `{protocolVersion:1, backendId:"x-harness"}` |
| event `{threadId, name, payload, agentName?}` | 同形；name/payload = x-harness 词表（§2.2）+ llm/chunk 合成域 |
| `settled {sendId, ok, reason?}` / `bash_execution_update {id, delta, truncated?}` | 同形同语义（合成域自有） |
| heartbeat 帧 | 同形 |
| sessionPath = `<agentDir>/sessions/<id>/transcript.jsonl` | `<agentDir>/sessions/<id>/events.jsonl`（内核布局） |
| 环境键 HUB_AGENT_DIR/HUB_SESSIONS_ROOT/HUB_WORKER_CWD/HUB_WORKER_PROVIDER/HUB_FAUX_SCRIPT | 同集；HUB_FAUX_SCRIPT → HUB_WORKER_SCRIPT；新增 HUB_WORKER_PROVIDERS（装配快照 JSON） |

## 4. 命令差异明细（客户端对接注意）

| 命令 | 差异 | 理由 |
| --- | --- | --- |
| prompt | images 携带已支持（BATCH2 起——量限/能力门/单 entry 图文同轮见 DESIGN §3.2；迁移期曾恒 failure `invalid images: unsupported by this kernel`）；无 unknown-command settled 面（合法词形交模型）；流式判定 = turn 在飞 ∨ send 在飞 | 内核 ContentBlock image 块（BATCH2 补齐）；无命令注册面 |
| steer/follow_up | images 同上 | 同上 |
| compact | 响应 `{summary, tokens}`（源码已是 `{summary, replacedCount}`）→ `{summary, replacedCount, summaryTokens}`；skip reason 完整映射（DESIGN §3.2——含 compaction failed:/aborted 归一） | compactionRunner 返回面 |
| get_state | model = `{provider, model}` 复合形（**字段名 model——源为 modelId 单字段，改名**）；queue = foldInbox `{steering, followUp}` | 内核词表 |
| get_entries | seq 0 基；event = `{type, ...data}` 摊平 + surfaceOp 随附；since/before 排他语义锚定（DESIGN §3.3） | 内核事件形状 |
| get_tree | 实现沿 header.parentSession 链（ancestors 不含自身；children 排除子代理会话） | 内核无现成查询 |
| get_session_stats | tokens 增可选 `cost`（内核 TokenUsage.cost 在场即透传——**升级**；源无 cost） | 内核 usage 链 |
| get_commands | source 收缩 `skill\|builtin`（无 plugin 源——内核无命令注册）；compact 条目 description 单点锚定 | 同上 |
| get_subagents | `{subagents: [{kind, agentId?, sessionId?, name?, ref?, type?, depth?, status: running\|idle\|stopped}]}`（delegationView ChildView 原样；源 8 字段 AgentView + busy\|idle\|on-disk 词表） | delegation 服务面 |
| subagent/steer | **入参字段 agentId（源码事实——源文档 agentName 为 lag）；gate = 驻留即投递**：running → 子代理步边界排队、idle → 立即唤醒开新轮（源仅 busy 可投）；非驻留拒 `subagent <agentId> not available (status: <status>)`（源文案 `not busy`）；投递 = delegationView.message（agent.steer 机制） | delegation 服务面语义升级 |
| get_models/set_model_override/models/add/remove | 目录 = providers.json 超集（provider 档案 + models 名单 + modelOverrides 节）；get_models source: preset\|custom | x-harness 目录形状 |
| auth/list | 全目录成员 + `{type: "api-key"\|"preset-env"\|"none"}`（源仅列有存 key 者且恒 "api-key"） | credentials 叠加模型 |
| set_model | 经 dial meta + waterfall 下一 turn 生效（源同构）；保留 thinking 档 × 目标不兼容 → 写前拒（文案 DESIGN 附录 A）；未知名 fail-closed 清单 = 档案 models | 词表差异 |
| set/get_thinking_level | 词表 `off\|low\|medium\|high\|max`（源无 max）；无值态归一 `"off"`（源线缆值 `"unset"`）；`model does not support thinking` 判据 = 目录 reasoning + protocol（openai 拒）；budget 校验退役（归内核 llm 拨号层） | 内核 ThinkingLevel |
| permission/set_mode/get_mode | 词表 `plan\|auto\|full`（源 plan\|default\|acceptEdits\|fullAuto）；即时切 = decide 面 + grants 授权面原子同步（源 controller 仅 decide 面——升级）；其余语义同构（即时/落盘/四态 source；controller.set 后置于 flush 成功） | 内核 ModeKnob + 服务面 |
| agents/list/create/remove | 条目 `{name, description, source: builtin\|project\|user, model?}`；frontmatter = x-harness delegation 格式（name/description/model/tools + body） | delegation 加载器 |
| skills/list/set_enabled/remove | source 词表 `builtin\|user\|project`（源 skill-builtin/skill-user/skill-project）；目录 = .x-harness/skills；stillDisabled by 恒 "user" | skill 包约定 |
| settings/get/set | 白名单键同集；值域随 thinking/permission 词表升级；双级/raw/sources 形态同构 | 词表差异 |
| thread/list_saved | 查询键收窄 `{cwd?}`（源 model/forkParent/updatedAfter/updatedBefore/limit/cursor 退役——客户端全量拉后自滤）；SessionSummary `{id, createdAt, updatedAt, title, model?, cwd?, forkParent?, messageCount, lastSeq}`——title 派生继承、updatedAt = 尾事件 time、forkSeq/depth/archived 缺席；排除子代理会话；>64MiB 单会话跳过 | 内核 header 字段集 |
| thread/resume | 撕裂写：末行截断恢复前缀（同源）；**中段坏行 fail-closed**（源坏行丢弃保前缀——有意变更：内核视为档案损坏宁可拒开）；零字节/空卷 hub 预检拒（源同） | 内核恢复器语义 |
| thread/retire | 唤醒在飞 → failure `thread not live`（源码事实——源文档「落地即收编」为 lag；新文档按代码） | 同 |
| fork/clone | durable boundary = 会话事件日志尾（in-memory 与 get_entries 同域）；fork 前 store.flush；其余同构 | 内核 fork 语义 |
| thread/start/resume | 入参 permissionMode/thinkingLevel 词表随内核；显式档 × 模型不兼容 → `thinkingLevel rejected: <reason>` 显式拒；sessionPath 布局变（§3） | 同上 |
| bash | confirm 弹窗三字段 {tool, summary, reason}（permission 面两字段 {tool, reason}）；id 缺省回落 = 请求 id；输出 8MiB 内存封顶 + 溢写文件名并入命令 key + 随机后缀（并发不覆写）+ 7 天清扫；abort_bash unknown id 落穿中止全部；spawn 同步抛错错误面应答（恰一）；溢写文件名 `<seq>.<key>.<rand>.txt` | AskRequest 形状/并发覆写修复 |

**收口审查处置的额外差异（方案与代码同变）**：skills/agents 同名优先级统一为
project > user > builtin（x-harness 内核装载序「前者胜」——源 skills 为 user >
project 的不一致收敛，运行时与清单面同序）；agents/list 补随包内置类型层
（general-purpose/explore/code-reviewer，`agent-types/` 随包分发，装载序末位，
remove 档拒 `agent type not user-defined`）；get_tree children 为全子树
（BFS 沿 parentSession）；list_saved{cwd} 双边 normalizeCwd；get_inflight
toolOutputs 执行中为空占位（内核无工具输出增量流面——终值经 WAL tool/result，
挂账内核加流面）；装配快照无 apiKeyEnv 不回退全局 env 键；worker host 关闭/
异常路径响应均 id-first（含 id 回显）；foldMeta/entries-project 原型污染与
type 遮蔽防护。

**事件面差异汇总**：message_* 系不存在（session 域 18+1 条 + 实时域 token 名——DESIGN
§4）；agents/* 七事件退役（delegationView 轮询 + 通知注入）；assistant 权威终局 =
WAL `assistant/message`（非 done 增量）；工具/usage/finish 增量经 `llm/chunk` 合成域；
turn/end reason 判别联合；inbox-full 退役。

## 5. 测试迁移矩阵（迁移源 40 测试文件 → 新去处；全覆盖对账）

| 迁移源测试文件 | 新去处 | 动作 |
| --- | --- | --- |
| jsonl / truncate / stdout-guard / contracts-frames / contracts-limits / contracts-queue / images（散布块） | src/__test__/（shared 契约矩阵） | 移植（HUB 键同集；frames 词表换 x-harness；queue 换 InboxSpliceData 形状） |
| pool-units / pool-caps / pool-deadlines / pool-fixture | src/__test__/（host pool；stub worker） | 移植（失败句柄回收/心跳单向/重键回归族） |
| host-threads / host-relay / host-readhistory-state | src/__test__/ | 移植（archive reader 折叠形状适配） |
| regressions-pool / regressions-races / regressions-units / regressions-crosspkg | src/__test__/ | 移植（21 项历史 bug 回归用例全量——编号与症状随迁） |
| **regressions-worker**（恰一响应核心回归锁：B-H1/B-M3 全命令恰一 failure 表驱动、B-H2/M4 shutting-down、B-M6 强制超时、B-M7 压缩预检、set_mode flush 失败不切 controller、bash data 形状） | src/__test__/ | 移植（全量） |
| **admin-commands-matrix**（workspace/trust 三形态、settings 双形态门禁、parkedPermissionMode 四态回退链） | src/__test__/ | 移植（词表断言随 §4 升级） |
| worker-commands / worker-commands-garbage / worker-embedded-commands / worker-embedded-races | src/__test__/（script-adapter 内嵌） | 移植（failure 必 emit 表驱动） |
| worker-read-shapes / worker-dial / worker-dial-journey / thread-commands-edge / worker-control-forks / worker-commands-fork-bash | src/__test__/ | 移植（dial/thinking 面 = meta+waterfall 断言；entries 游标用例散在源 regressions-units/host-relay——随其迁移） |
| settings-worker / settings-admin / settings-project-store / settings-project-worker / settings-runtime | src/__test__/ | 移植（词表断言随 §4 升级） |
| worker-bash / bash-exec-edge / bash-exec-hardening | src/__test__/ | 移植（并发超时互不误杀/admission 域键控/进程组杀/unknown id 落穿） |
| worker-shutdown-sweep / worker-harness / worker-rt-fixture | src/__test__/ fixtures | 移植（FakeInput/captureWriter/fakeRt 换内核形状） |
| test/harness.ts / smoke.test.ts | src/__test__/kit/host-client.ts + src/__test__/smoke.test.ts | 移植（55 命令矩阵 + 计时断言） |
| test/scenarios-{contract,lifecycle,resilience}.test.ts | src/__test__/scenarios-*.test.ts | 移植（kill/并发 resume/retire-wake/orphan/stop-vs-wake/撕裂双形态/背压/隔离/直读/收敛/fork/trusted/设置旅程） |
| test/llm-e2e.ts | src/__test__/llm-e2e.ts（opt-in） | 移植（compat adapter 拨号；模型经 providers.json custom） |

新增（无源对应）：内核加法四件单测（core/session、permission、skill、agent-delegation
包内 + 既有词表测试名更新）；script-adapter 剧本映射/abort；dial/thinking waterfall
端到端（request/context 落盘断言）；foldInbox 四源；inbox clear 直写；catalog 装配
快照注入；llm/chunk tap；respond() 单点契约（key 序 + worker 全路径响应核销）。

## 6. 挂账清单（显式，逐条归属）

| 挂账 | 归属 |
| --- | --- |
| ~~prompt/steer images 支持~~ **已实施（BATCH2-DESIGN §1）** | 内核 ContentBlock image 块 + hub 量限/能力门 + 单 entry 图文同轮 |
| worker stdout writer 无界串行队列（慢 host + 高频帧下待写闭包无界堆积） | 背压/有界队列独立收敛（BATCH2 审 M1 登记；新增面已节流） |
| 会话删除命令 | hub 目录级删除加法（BATCH2-DESIGN §4 实施中） |
| 子代理实时事件面（agents/* 七事件等价物） | delegation 事件面加法（BATCH2-DESIGN §3 实施中） |
| 项目数据目录名自定义（dirs.projectName 类） | 设置键扩展（当前恒 .x-harness） |
| 项目级 permission allow/deny 规则 | permission RuleOrigin 接入（源仓挂账继承——deny 先行不对称序） |
| 本地不提交层（settings.local） | 源仓挂账继承 |
| model.default 项目级键 | 源仓挂账继承 |
| telemetry sqlite | 产品面未消费，按需加 kit |
| ProvidersConfig 类型上提共享包（hub 与 apps/cli 各持一份） | 仓级收敛后续波（当前 hub 超集自持） |
| get_thinking_levels 可用档清单 / agents history() 读口 / 会话属性变更事件 / 压缩进度可观察面 / entry_appended 增量对账事件 | 源仓跨包深审挂账继承（按客户端需求加法） |

## 7. 回滚方案

新 app 独立目录；内核改动四件均纯加法/可选参（逐包独立 revert；GrantsRegistry
签名改动限内核包内调用点）；无 schema/数据动作（providers.json/hub-settings/
credentials 首跑缺席 = 空态零迁移）。每实施波独立提交（引用本文节号）。

## 8. 验收（全部满足才算完成）

- [ ] 四门全绿（lint 0-0 / typecheck / build（含 host-hub 双入口产物）/ test+覆盖率：
      行/语句/函数 ≥90、分支 ≥85；worker/ 以内嵌测试真实覆盖，无豁免）
- [ ] 契约 smoke 全绿（55 命令矩阵 + 转发计时 + stdout 纯净 + 错误文案对照 DESIGN
      附录 A）
- [ ] 场景 e2e 全绿（含 trusted 门禁 / backpressure / settled 死亡合成 / 撕裂双形态 /
      设置面旅程）
- [ ] 双形态冒烟通过（源码 + 产物，`/$bunfs/` 自举复测）
- [ ] §5 矩阵逐条落位（40 文件全覆盖对账；无静默删测试；删除域全部有裁决出处）
- [ ] 实施后对抗审查（独立子代理对照源实现）偏差处置清零
- [ ] 假绿对抗抽查产出核查清单
- [ ] 文档状态推进「已核销」；如实报告用例数与覆盖率数字

## 9. 实施记录

（实施期填写）
