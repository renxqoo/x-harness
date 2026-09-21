# host-hub 施工图（IMPLEMENTATION）

> 状态：已核销（波 0-4 全交付 + 收口审查/假绿抽查处置清零；MIGRATION §8 全勾）
> 状态流转：草稿 → 定稿 → 实施中 → 已核销
> 前置：[DESIGN.md](DESIGN.md)｜[MIGRATION.md](MIGRATION.md)
> 审计基线：迁移源仓自带已核销审计（21 项 bug 修复 + 六轮设置面评审——继承代码即
> 继承修法）；本仓两轮独立对抗审查（契约面 2H/13M/16L + 内核映射面 4H/13M/6L——
> 全部处置落进三份文档，关键裁决见 DESIGN §10）。

## 1. 审计结论引用

- 迁移源 21 项历史 bug（A-*/B-*）修法**随代码同构继承**（回归用例一并移植）。
- 迁移源实施期已根治的缺陷（jsonl 超限行绕过、帧检测 key 序、dispatch 反转、fork
  写锁、产物形态双重执行等 6 项）修法随代码继承。
- 本仓审查新增关键裁决：worker 全部响应经单点 respond() id-first 序（源 type-first
  内联字面量会绕过 host 对账——恰一破坏隐患）；delegation 经服务面直调（工具
  dispatch 撞 permission ask 墙）；permission 即时切经插件恒提供服务 + 可撤销授权面。

## 2. 逐模块裁决表

迁移源 src 共 **50 生产文件**（host 19 + worker 17 + shared 11 + protocol 3，
≈6.4k 行）。裁决原则：**host 机器簇内核无关 → 同构重写；worker 命令簇贴内核 →
重写（行为映射可指认）；shared 机器层 → 同构重写；protocol → 同构重写换词表**。

### 2.1 host 机器簇（内核无关——同构重写，仅类型/工具替换）

| 迁移源文件 | 裁决 | 动作 |
| --- | --- | --- |
| host.ts / cli.ts | 重写（同构） | 引导序（接管→心跳→路由）；runWorker await；双角色分派；backendId "x-harness"；agentDir 缺省 ~/.x-harness/hub；启动接线 bash-outputs 7 天清扫 |
| worker-pool.ts | 重写（同构） | 唤醒循环/排队至 close 重评（每线程 1024 上限）/shutdownAll 不发死亡帧/先记后写；失败句柄 onClosed；internal id `@hub-internal:`；在飞驱动 id 登记；死亡对账 + settled 死亡合成（源内联于本文件，不另拆） |
| worker-process.ts | 重写（同构） | 三形态 spawn 自解/串行写/close 死亡信号/128MiB 违例杀 |
| worker-frames.ts | 重写（同构） | 前缀分派/hello 握手/控制响应先改表后转发/单向再同步/畸形控制 stderr+有界等待 |
| worker-control.ts | 重写（同构） | **host 侧控制响应路由**（internal ack 兑现、thread/start\|resume @pending 落表+重绑、fork 重键、payload 词法校验入表） |
| thread-table.ts | 重写（同构） | 三映射/占位即占用/1024 FIFO/重键；心跳单向迁移 |
| thread-retire.ts / thread-stop（源并入各文件） | 重写（同构） | sweep 五分支；rss NaN 防御；retire 按 worker 域反查；stopRequested 闭包结算 |
| read-history.ts / parked-reads.ts | 重写 | x-harness archive reader（createArchiveReader.read）+ meta 折叠；fail-open 回落唤醒；围栏用内核 isSafeSessionId；零字节/空卷 hub 预检 |
| saved-query.ts | 重写（微修） | cwd 过滤按 header.cwd；子代理会话滤除（agentId） |
| credentials.ts | 重写（同构） | 0600/零回显/脱敏 |
| tmp-sweep.ts | 复制（微修） | 启动清扫 `*.pid.*.tmp`（mtime>1h）+ bash-outputs 超 7 天溢写文件 |
| host-commands.ts | 重写 | thread/* 全生命周期 + get_models/set_model_override + auth/* + get_host_info/旋钮 + ui_response 路由 + agents/list（loadAgentTypes）；目录层换 providers.json 超集 |
| admin-commands.ts | 重写（同构） | settings/get/set 双级形态 + workspace/trust + models/add/remove 路由 |
| models-admin.ts | 重写 | providers.json 超集校验/窄合并/原子写 |
| skills-admin.ts / agents-admin.ts | 重写 | x-harness 目录约定（~/.x-harness/{skills,agents}、<cwd>/.x-harness/...）；agents frontmatter 严格集 round-trip |
| trust-store.ts | 重写（同构） | trusted-workspaces.json 读写（串行链 + 原子写）；注册表 ∪ live 集合判定 |

### 2.2 worker 命令簇（贴内核——重写，行为映射见 MIGRATION §2）

| 迁移源文件 | 裁决 | 动作 |
| --- | --- | --- |
| worker.ts / main.ts | 重写（同构） | hello→心跳→命令循环→shutdown 序（子代理 stopAll → 手动压缩 abort → inflight abortAll → broker denyAll → bash abort → dispose → flush → exit 0）；**全部响应经单点 respond() id-first 序**；HUB_WORKER_DISPATCHED 哨兵 |
| assembly.ts | 重写 | createAgentWorld + kits 配方；loop.create/resume；script-adapter 注入缝（HUB_WORKER_PROVIDER=script + HUB_WORKER_SCRIPT JSON）；trusted 门禁（skills/agents 目录 + 项目设置）；permissionMode 服务接线 |
| worker-commands.ts / thread-commands.ts / worker-read-commands.ts / settings-commands.ts | 重写 | 命令注册表 failure 单点全 emit；dial/thinking/permission 会话面走 session/meta + waterfall 挂点；fork 重装配走公共腿（含 fork 前 flush） |
| event-bridge.ts | 重写 | sessionEvent bus + agentAssistantStream + agentStatus + compaction/permission bus → wire；settled 合成（whenIdle 收敛）；**llm/stream waterfall tap → llm/chunk 合成域**；dial/thinking 挂点插件 |
| dialogs.ts | 复制（同构） | DialogBroker 恰一 settle/键过滤/强制超时——permissionBroker 服务提供者 + bash 准入共用 |
| bash-exec.ts | 重写 | Bun.spawn detached 进程组 + per-command AbortController + 两段杀自实现；8MiB 内存封顶/粘滞；溢写 + 7 天清扫；信封 append user/message + flush；admission worker 域键控 |
| compact-invocation.ts | 复制（同构） | /compact 行首词法（images 拒） |
| inflight.ts | 重写（同构） | turnStartSeq（turn/start 事件 seq）；assistant partial 从 agentAssistantStream + llm/chunk 累积；toolOutputs 尾部 64KiB×8 粘滞 |
| entries-window.ts | 复制 | 游标矩阵原样（since 排他前向 / before 排他后向 / limit 最近 N / 空窗收敛）；seq 0 基为声明差异 |
| command-listing.ts | 重写 | loadSkills 清单 + builtin compact（description 单点锚定） |
| current-dial.ts / dial-supports-thinking.ts / session-meta.ts | 重写 | foldMeta 单点（session/meta 尾值）；thinking 校验（词表 + 目录 reasoning + openai 协议拒） |
| worker-control（worker 侧控制器部分） | 重写 | permissionMode 服务消费 + meta 折叠初值（dial/thinking/permission） |

### 2.3 shared 机器层（同构重写）

| 迁移源文件 | 裁决 | 动作 |
| --- | --- | --- |
| jsonl.ts | 复制（同构） | LF 分帧/代理对折算/单行单报/行级判定入 drain |
| truncate.ts | 复制（同构） | 64KiB 尾部/粘滞/marker 退化 |
| limits.ts | 复制（微修） | HUB_* 键原样；缺省单点 + 死线/风暴上限常量 |
| images.ts | 复制（微修） | 形状校验（全五文案）+ `unsupported by this kernel` 拒绝面 |
| stdout-guard.ts | 复制（同构） | 两层接管/串行队列/EPIPE 退出/重试上限 100 降级 |
| frame-classify.ts | 复制（同构） | 前缀集 key 序契约（单测锁定 + respond() 单点契约并入） |
| atomic-file.ts | 复制（同构） | tmp+rename 原子写/分链串行/空闲回收 |
| event-log.ts | 重写 | 撤 transcript 直读（归内核 archive reader）；bash-outputs 溢写 helper |
| queue-fold.ts | 重写 | foldInbox 文本投影（内核单源；steering←nextStep / followUp←nextTurn） |
| models-catalog.ts（源 shared） | 重写 | providers.json 超集 + 预设 + modelOverrides + credentials 叠加 + 装配快照构造 |
| settings-store.ts（源 shared） | 重写（同构） | 双级读取/分链串行写/回收/白名单校验/坏值逐键丢/合并视图 |
| script-adapter.ts（新增） | 新写 | JSON 剧本 → LlmAdapter（测试缝；abort 抛 AbortError 对齐内核契约） |
| hub-log.ts（新增） | 新写 | stderr 两级前缀（no-console 门内封装） |
| entries-project.ts（新增） | 新写 | SessionEvent → wire {seq, ts, event} 摊平投影（worker/直读共用） |
| meta-fold.ts（新增） | 新写 | session/meta 尾值折叠（dial/thinking/permission/title 单源） |

### 2.4 protocol

| 迁移源文件 | 裁决 | 动作 |
| --- | --- | --- |
| commands.ts | 复制（微修） | COMMAND_NAMES 55 同集；入参形状（images 保留 + 拒绝面） |
| frames.ts | 重写 | 帧联合 + 事件词表 = x-harness 内核词表 + llm/chunk（DESIGN §4） |
| internal.ts | 复制（微修） | THREAD_SCOPED/HOST_RELAYED/OBSERVER/DRIVING 清单原样；backendId "x-harness" |

### 2.5 不移植域

| 迁移源 | 理由 |
| --- | --- |
| dial-supports-thinking 的 THINKING_INJECTION_APIS/faux 例外 | x-harness llm 包自带 THINKING_BUDGETS 与注入逻辑；校验面按 protocol（anthropic 映射、openai 拒） |
| provider-faux 依赖 | script-adapter 自实现（testkit 不进生产路径） |
| plugin-workspace shell helpers | bash-exec 自实现 detached 进程组两段杀 |

## 3. 内核纯加法四件（先行波次；各自带单测；独立可 revert）

1. **core/session：`session/meta` 日志事件**。`SessionEventData` 增
   `"session/meta": { readonly key: string; readonly value: unknown }`（LogOnly——
   不进 surface 投影、WAL 单一事实的会话级 KV last-wins 通道；validateSessionEvents
   按 key 非空字符串校验）。服务 title/dial/thinking/permission-mode 全部持久面。
   **不折叠进内核**——fold helper 归 host-hub（消费方语义，内核只运不判）。随加更新
   既有 17 词表测试名/注释（gates.test「17 词条」、telemetry fold「全 17 词条」）。
2. **permission：`permissionMode` 服务 + 可撤销授权面**。插件**恒提供**
   `permissionMode` 服务 `{get(): ModeKnob; set(mode: ModeKnob): void}`——decide 面
   每判读现值（mode 不再闭包捕获）；set 原子切 mode + `GrantsRegistry
   .setUnrestricted(enabled: boolean)`（签名改布尔——现无参调用点语义 = true；离开
   full 即撤，网络代理/extraRoots 授权面同步）。fenceKit 无需改（服务从 ctx 取）。
3. **skill：`disabled` 名单**。`SkillPluginOptions` 增
   `disabled?: readonly string[]`——合并后按名过滤（清单与快照同滤）。
4. **agent-delegation：`delegationView` 服务面 + barrel 导出**。插件提供
   `delegationView` 服务（worker 单主会话形态）：`list(): readonly ChildView[]`、
   `message(to: string, text: string): Promise<SendResult>`、`stopAll(cause: string):
   Promise<void>`——hub 直调，绕开工具 dispatch 的 permission ask 墙与 ChildView
   文本解析；barrel 补导出 `loadAgentTypes/resolveAgentDirs`（types-loader）。

## 4. 拆分决策（目标目录结构）

```
apps/host-hub/
  docs/                          # 本文档族
  src/
    protocol/commands.ts         # 命令联合（外部面，55）
    protocol/frames.ts           # 帧联合 + 事件词表（内核镜像+合成域）
    protocol/internal.ts         # hello/心跳/THREAD_SCOPED/OBSERVER/HOST_RELAYED/DRIVING 清单
    shared/jsonl.ts  truncate.ts  limits.ts  images.ts  event-log.ts  hub-log.ts
    shared/stdout-guard.ts  frame-classify.ts（成对，key 序契约 + respond 单点）
    shared/atomic-file.ts  inbox-fold.ts  meta-fold.ts  entries-project.ts
    shared/catalog-types.ts  catalog.ts  presets.ts
    shared/settings-store.ts     # hub-settings 双级（用户/项目）+ 分链写
    shared/script-adapter.ts     # JSON 剧本 → LlmAdapter（测试缝）
    host/cli.ts                  # 入口（--internal-worker 分派；main guard）
    host/host.ts                 # 引导（接管→心跳→路由→shutdown）
    host/thread-table.ts  thread-retire.ts  thread-stop.ts
    host/worker-pool.ts  worker-process.ts  worker-frames.ts  worker-control.ts
    host/host-commands.ts        # host 本地命令（生命周期/模型/凭据/旋钮/agents）
    host/admin-commands.ts       # settings/workspace-trust/models 路由
    host/read-history.ts         # parked/dead 直读（archive reader + fold + 围栏）
    host/models-admin.ts  skills-admin.ts  agents-admin.ts
    host/trust-store.ts  credentials.ts  tmp-sweep.ts
    worker/main.ts               # 入口（main guard；run 可单测）
    worker/worker.ts             # 引导（hello→心跳→命令循环→shutdown；respond 单点）
    worker/assembly.ts           # world 装配方（providers 参数化注入缝）
    worker/worker-commands.ts  worker-read-commands.ts  worker-meta-commands.ts
    worker/event-bridge.ts       # bus→wire（settled 合成 + llm/stream tap）+ dial 挂点
    worker/dialogs.ts            # DialogBroker（强制超时；permissionBroker 提供者）
    worker/compact-invocation.ts # /compact 拦截词法
    worker/command-listing.ts    # get_commands 目录
    worker/bash-exec.ts          # 直执行（执行器+confirm+信封+flush+溢写）
    worker/inflight.ts           # registry+state+收敛读
    worker/entries-window.ts     # seq 游标窗口
    worker/meta-state.ts         # session/meta 折叠读口（dial/thinking/permission/title）
    __test__/                    # 全部测试（单测 + smoke + 场景 e2e + kit + llm-e2e opt-in）
      kit/host-client.ts
      smoke.test.ts  scenarios-*.test.ts  llm-e2e.ts（opt-in，bun 直跑）
  package.json
```

- **测试全部落 `src/__test__/`**：根 vitest include = `apps/*/src/**/__test__/**/*.test.ts`
  ——`src` 外的 `test/` 目录不命中（静默不跑 = 假绿）；opt-in llm-e2e 同置但非
  `.test.ts` 后缀（vitest 不收、tsconfig 覆盖）。
- **覆盖率不申请豁免**：coverage exclude 的 worker 豁免仅限 `packages/*/src/**/worker/**`
  （为 plugin-manager 真线程而设）——host-hub worker 文件是普通模块，**以内嵌测试
  （runWorker 注入 stdin/stdout + script-adapter）真实覆盖进分母**；如实申报。
- oxlint 约束塑造拆分：max-lines 500 / max-params 3 / complexity 15 / max-depth 4 /
  no-console（hub 日志走 process.stderr.write 封装 hub-log.ts；apps/host-hub 不在
  no-console 豁免名单）。迁移源 host-commands 568 行、worker-commands 563 行 →
  按域拆读命令/元命令文件。
- package.json：`@x-harness/host-hub`，exports `./host` → src/host/cli.ts、
  `./worker` → src/worker/main.ts；依赖 @x-harness/{core,harness,session,agent-loop,
  llm,llm-retry,compaction,autocompact,permission,skill,agent-delegation,
  session-persistence-jsonl,md-frontmatter}；testkit 不进生产路径。
- **build 门**：根 `build` 脚本扩列 host-hub 双入口产物（`bun build apps/host-hub/
  src/host/cli.ts apps/host-hub/src/worker/main.ts --outdir apps/host-hub/dist --target
  bun --format esm --external "@x-harness/*"`）——双形态冒烟依赖产物，根门显式覆盖。

## 5. 测试计划

1. **单元（src/__test__/）**：shared 契约矩阵（jsonl 字节真值/代理对/超限；truncate
   粘滞；stdout-guard 重试上限降级；frame-classify key 序 + 不 parse body 断言 +
   respond 单点契约；limits 钳制；images 形状全文案；catalog 校验/窄合并/降级/快照；
   settings-store 白名单/双级/分链回收；script-adapter 剧本映射/abort）；thread
   状态机（stub worker；心跳单向/失败句柄回收/retire 重键/NaN rss 回归族）；
   worker-pool 死亡对账 + settled 死亡合成；entries-window 全矩阵；dialogs 强制超时；
   inflight 尾部；credentials 零回显/脱敏；bash-exec 校验/并发超时互不误杀/admission
   域键控/unknown id 落穿；worker-commands 全命令 happy/error 表驱动（failure 必
   emit）；event-bridge 词表 + llm/chunk tap；inbox-fold 四类写入源；定时器计数断言。
2. **worker 内嵌（script-adapter 驱动；覆盖 src/worker/ 全文件）**：prompt 双路径
   （空闲 followup + 流式 steer/followup 降级）；settled 恰一/排序/错误面/无 id 不发；
   steer/followUp 消费时机；abort 级联+压缩联动；compact 预检+customInstructions 透传
   +skip reason 映射；/compact 拦截矩阵；set_model 下轮生效（agentRequest 改写 +
   request/context 落盘）+ 保留档不兼容拒；fork 模型继承 + fork 前 flush；thinking
   档通路（剧本断言 dial.thinking）+ resume 恢复 + openai 协议拒；permission mode
   即时切（decide 面 + 授权面）；get_entries 游标多轮；get_state 折叠；get_commands
   目录；get_subagents/subagent-steer 服务面。
3. **进程契约 smoke**：55 命令矩阵黑盒（恰一响应/id 回显/command 字段/错误文案对照
   附录 A/心跳/EOF exit 0/stdout 纯净/转发计时 <1ms 量级）；隔离 HUB_AGENT_DIR。
4. **场景 e2e（src/__test__/scenarios-*.test.ts）**：kill -9 中途（补 failure+
   thread_died+复活+settled 合成）；并发 resume 恰一胜者；retire→parked→wake；孤儿
   自灭；stop-vs-wake；撕裂会话文件（末行截断恢复 + 中段坏行 fail-closed）；
   backpressure（慢客户端）；4 并发隔离（事件不串线程 + 进程树 RSS 采样）；直读；
   收敛读重连合并；fork 全旅程；trusted 门禁（装载差异）；设置面旅程（models/add→
   start 用新模型→agents/create→list 可见→skills 开关→thinking→permission→parked
   get_mode 读 WAL→trust→项目级合并视图）；spawn 冷启动计时（记录项）。
5. **real LLM 门（opt-in 不进默认门禁）**：`src/__test__/llm-e2e.ts`（`bun run
   e2e:llm`，GLM_API_KEY 缺省回落 packages/e2e/.env 同源）——真 host 进程 + 真
   worker + 真 compat adapter 拨号；旅程：heartbeat→host_info→start(modelId)→prompt
   settled→get_entries（WAL assistant 消息）→标题→fork 分支→多会话并发（5 线程隔离+
   批量收编）→retire→parked 直读→wake→EOF exit 0。
6. **双形态冒烟**：源码 + bun build 产物（`/$bunfs/` worker 自举复测）。

**假绿对抗抽查操作定义**（收口前独立子代理）：对照 MIGRATION §5 矩阵逐行核对新测试
存在性；grep `skip|only|todo` 零命中；核对 vitest 阈值未被修改；抽查 3 个断言改弱嫌疑；
产出核查清单进 MIGRATION §9。

**覆盖率**：行/语句/函数 ≥90、分支 ≥85（vitest v8 真实强制）；worker/ 文件以内嵌
测试真实覆盖（无豁免——§4）。

## 6. 实施顺序（每步提交四门全绿）

1. **波 0**：内核纯加法四件 + 各包单测（含既有词表测试名更新）；
2. **波 1**：shared 机器层 + protocol 词表 + 单测；
3. **波 2**：worker 侧全件 + script-adapter 内嵌测试（真实覆盖率）；
4. **波 3**：host 侧全件 + stub 单测；
5. **波 4**：smoke + 场景 e2e + 双形态冒烟 + real 门（opt-in）+ 根 build 扩列；
6. **波 5**：四门 + 覆盖率核 + 独立子代理对抗审查（对照 MIGRATION 附录）→ 处置清零 →
   假绿抽查 → 收口核销。

「一步到位」= 55 命令全量一次交付；波次仅是失败域逐级放大的施工排布。
