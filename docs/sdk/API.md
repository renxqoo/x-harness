# API — @x-harness/agent-sdk 完整使用参考

状态：定稿 v2（审查 A/B 意见已合并处置）
上游文档：docs/sdk/DESIGN.md

安装：monorepo 内 `"@x-harness/agent-sdk": "workspace:*"`。

```ts
import { createSdkClient } from "@x-harness/agent-sdk";
```

所有异步方法返回判别联合 `{ ok: true; value: T } | { ok: false; reason: SdkErrorShape }`，
不抛业务异常；垃圾输入返回失败结果或空形态，不崩溃。

---

## 1. createSdkClient(options) → SdkClient

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| mode | `"in-process" \| "worker"` | 是 | in-process：线程在当前进程（服务端多住户/cli）；worker：每线程一个子进程（桌面/host-hub） |
| agentDir | string | 是 | agent 数据根：skills/plugins/agents/catalog/credentials/telemetry |
| sessionsRoot | string | 是 | 会话 JSONL 根（`<root>/<sessionId>/events.jsonl`） |
| env | Record | 否 | per-client 环境快照（缺省 process.env 拷贝，创建时冻结）。catalog/limits/script-adapter/凭据 env 全走它；多租户必传，防跨租户 env 泄漏 |
| mailboxRoot | string | 否 | 缺省 agentDir 派生，禁止回退 ~/.x-harness |
| workflowRoot | string | 否 | 同上 |
| skillsDirs | string[] | 否 | 缺省按 trusted 规则派生（project+user） |
| rgBinDir | string | 否 | 缺省 agentDir/bin |
| confirm | (fields) => Promise\<verdict\> | 否 | confirm/ask 注入；省略则走 ui_request 事件 |
| persistence | `"durable" \| "inline"` | 否 | 会话持久化（缺省 durable；inline = cli --noSession 语义，此时无 taskLogDir） |
| compaction | { triggerPct?, autocompact?: false, keepRecentTokens?, keepMinTurns? } | 否 | 压缩自由度全集（cli 差异面） |
| retryPerProvider | Record\<provider, RetryPolicy\> + default | 否 | per-provider 重试表（缺省 SDK 内置单表） |
| telemetryResourceName | string | 否 | 遥测 serviceName（缺省按消费方派生） |
| features | { commands?, todo?, externalPlugins? } | 否 | 命令面/todo/外部插件开关（缺省全开；cli 可关） |
| apiKeyOverrides | Record\<provider, string\> | 否 | per-provider 密钥覆盖（不落盘；对应 cli per-provider override） |
| limits | Partial\<SdkLimits\> | 否 | 见 §7；idleRetireMs: 0 = 关（交互形态默认） |
| onEvent | (e: SdkEvent) => void | 否 | 全局事件流 |
| onLog | (message: string) => void | 否 | 诊断日志出口（SDK 不直写 stderr） |
| spawnOverride | typeof spawnWorker | 否 | worker 模式子进程注入（测试位） |
| execPath | { command, args } | 否 | worker 模式入口覆盖（桌面自管进程） |

进程级保证：in-process 模式 SDK 不注册任何进程级钩子、不 process.exit、不劫持
stdout、不裸读 process.env、无模块级可变单例。

## 2. SdkClient 生命周期

```ts
await sdk.startup();    // 幂等：建目录、迁移、清理
await sdk.shutdown();   // 幂等：retire 全部线程；client 对全部未决 sendId 合成
                        // settled(ok=false, reason="shutdown")；总预算 30s
```

## 3. 线程生命周期

### 3.1 startThread(spec)

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| cwd | 是 | 工作目录（工具沙箱根） |
| trusted | 否 | 加载项目级 .x-harness/{skills,agents} |
| dial | 否 | {provider, model}；缺省 catalog 默认 |
| thinkingLevel | 否 | off/low/medium/high（不支持 → capability_thinking） |
| permissionMode | 否 | 缺省 settings 解析链，无设置 auto |
| prompt | 否 | 首条消息（birth 缓冲保证句柄创建起的事件不丢） |
| images | 否 | ≤8 张/单张 5MB/总量 12MB |
| sendId | 否 | 调用方注入（缺省 SDK 铸造；与 settled 一一对应） |
| apiKey | 否 | 一次性密钥（不落盘；cli --api-key 语义；优先于 catalog/credentials） |
| tools / excludeTools | 否 | 工具限制（cli --tools 语义） |
| systemPromptAppend | 否 | cli --append-system-prompts 语义 |

skillsDirs 显式注入即完全覆盖（不再叠加 project 目录）；缺省时按每线程 trusted
派生（project+user / 仅 user）。registerSession 入参为 sessionPath，
sessionPath→threadId 的 fence（布局校验）在 SDK 内完成，薄壳直传。

command() 返回值受行上限约束：单帧 ≤ CLIENT_LINE_LIMIT 16MB（worker 链路
≤ WORKER_RESPONSE_SOFT_CAP 100MB）；超限返回 io_failed。

失败码：thread_limit、invalid_input、internal。

### 3.2 resumeThread(spec)——「重启 agent」

threadId（持久化会话 id）必填；parked/dead/未知均可唤醒。cwd/trusted/dial/
thinkingLevel/permissionMode 可覆盖。失败码：session_unreadable（不可读）、
already_open、thread_limit、invalid_input。

### 3.3 句柄方法

```ts
thread.retire(): Promise<SdkResult<void>>;  // 三态：ok | state_conflict | thread_not_live
thread.stop(): Promise<void>;
thread.state;   // spawning|live|retiring|parked|dead
thread.info;    // { threadId, cwd, trusted, sessionPath, state, keepalive, idleMs, isStreaming }
```

fork/clone 后发 thread_rekeyed 事件；旧句柄调用返回 thread_superseded，
以 sdk.threadOf(newId) 重建。

### 3.4 registerSession——仅登记不唤醒

```ts
sdk.registerSession(sessionPath, { trusted }): Promise<SdkResult<void>>;
// 入参 sessionPath（threadId 由 SDK fence 反解）；校验会话文件（≤64MB、header
// 可读）→ 插入 parked 表项；不启动任何执行
```

## 4. 消息（三入口不折叠）

### 4.1 send(text, options?) —— 发送并等待该回合 settled

| options | 说明 |
| --- | --- |
| images | 同 startThread 限额 |
| sendId | 调用方注入的 id（与 settled 一一对应；适配层复用 wire 帧 id） |
| timeoutMs | 等待上限；超时 { ok:false, internal timeout }，线程继续 |

运行中 send 默认排队（inbox 语义），**排队 send 绑定触发其回合的 turn/start
seq，各自结算**。settled.ok=false 时仍返回 `{ ok:true, value:{ok:false,reason} }`
（业务结果非 SDK 错误）。

### 4.2 steer(text) —— 运行中注入当前回合（wire steer 语义）
### 4.3 followup(text) —— 显式排队下一回合
### 4.4 abort(cause?) → Promise —— 取消链全部落地后 resolve；settled(ok=false) 必达
### 4.5 queueSendNow(entryId) —— 重定向已排队 entry（需运行中回合；找不到 → state_conflict）

**斜杠命令分发**：send 文本以 `/` 开头先进 @x-harness/commands 注册表（与
compact 入口同律）；命中返回命令结果不产生回合；未命中才作为消息。
runCommand(line) 是显式入口。

## 5. 命令面

### 5.1 线程级（command(name, args)）

以 vocab 派生集合为源（契约测试断言文档表 == 集合）：

- 回合：abort、clear_queue、queue/drop、queue/send_now
- 查询：get_state、get_inflight、get_messages、get_entries、get_tree、
  get_session_stats、get_token_analytics、get_fork_messages、get_subagents、
  get_pending_dialogs、get_commands、get_plugins、get_thinking_level
- 元数据：set_session_name、set_model、set_thinking_level、thread/set_keepalive、
  thread/notify（live-only）
- 操作：compact、fork、clone、bash、abort_bash、catalog/reload、
  plugins/hot_install、plugins/hot_uninstall
- skills（线程级）：skills/inspect
- workflow：workflow/list、workflow/submit、workflow/stop
- 子代理：subagent/steer
- ui：ui_response
- permission（双路由）：permission/set_mode、get_mode、grant、list_rules、remove_rule

### 5.2 client 级

```ts
sdk.listThreads(): SdkResult<ThreadInfo[]>;
sdk.threadOf(threadId): SdkThreadHandle | undefined;
sdk.listSavedSessions(): Promise<SdkResult<SavedSessionInfo[]>>;
sdk.registerSession(sessionPath, opts?): Promise<SdkResult<void>>;
sdk.deleteSession(threadId): Promise<SdkResult<void>>;
sdk.exportSession(threadId, path): Promise<SdkResult<{path}>>;   // cli /export 原语
sdk.limits.setIdleRetireMs(ms): void;   // 0 = 关
sdk.limits.setRssRetireBytes(n): void;  // 0 = 关
sdk.admin.skills.* / plugins.* / models.* / auth.* / settings.* / agents.* / permission.*
sdk.admin.hostInfo(): SdkResult<HostInfo>;      // get_host_info：版本/启动时间/limits
sdk.admin.trustWorkspace(cwd): Promise<SdkResult<void>>;   // workspace/trust
sdk.usage(threadId): SdkResult<TokenUsage | undefined>;    // 每回合/累计 usage（cli /usage 面，get_token_analytics 同源）
```

**permission 双路由**：无 threadId 或 parked/dead → admin 直读（会话 WAL + 设置
回溯推导）；live → 透传线程；同构结果。

## 6. 事件流

```ts
sdk.onEvent((e) => {...});            // 全局
thread.on(kind, listener): () => void;  // 类型化线程级
for await (const e of thread.events) { ... }  // birth 缓冲 + 有界；break 即释放
```

| kind | 载荷 | 时序契约 |
| --- | --- | --- |
| stream | frame: {phase:start/chunk/end, kind, text} | 原帧透传（cli 渲染依赖 phase） |
| tool_stream | callId, delta | 25ms 节流 |
| tool_result | callId, summary, ok | 同 callId 流结束之后 |
| settled | sendId, ok, reason? | 每 sendId 恰好一次；sendId="" 为回合结束信号（保留 wire 语义） |
| platform | name, payload, agentName? | 平台 token 事件无损透传；不享受稳定性承诺 |
| session | event: SessionEvent（含 surfaceOp） | seq 单调 |
| ui_request | requestId, method, payload, respond | respond 恰好一次；迟到 no-op |
| thread_state | from, to, cause | 单调 |
| thread_rekeyed | oldThreadId | fork/clone 换 id；旧句柄 superseded |
| git_changed | cwd, branch? | git 监听 |
| heartbeat | idleMs, streaming, rssBytes | 1s |
| error | code, message | 非致命；含背压 dropped 计数 |

缓冲契约：句柄 events 从创建时刻起缓冲（birth 缓冲，订阅前不丢）；容量
eventQueueCapacity；溢出丢 stream/tool_stream 并补 error；终态事件永不丢；
resumeThread 后事件仅向后（历史走 get_entries）；三条订阅面同源同序。

## 7. SdkLimits

| 键 | 缺省 | clamp |
| --- | --- | --- |
| maxThreads | 32 | ≥1 |
| idleRetireMs | 900_000（交互形态建议 0=关） | 0 或 [1s, 24h] |
| rssRetireBytes | 0（关） | 0 或 [256MB, 2TB] |
| bashTimeoutMs | 600_000 | [0, 24h] |
| confirmTimeoutMs | 300_000 | 0（无超时）或 [1s, 24h] |
| requeueMaxPerThread | 1_024 | ≥1（worker 模式） |
| requeueMaxBytesPerThread | 4MB | ≥1KB（worker 模式） |
| shutdownBudgetMs | 30_000 | [1s, 120s] |
| workerStaleMs | 30_000 | [1s, 24h]（worker 模式） |
| workerExitTimeoutMs | 10_000 | [1s, 24h]（worker 模式） |
| pendingCommandsCap | 65_536 | ≥1 |
| eventQueueCapacity | 1024 | ≥16 |

响应/行上限：CLIENT_LINE_LIMIT 16MB / WORKER_RESPONSE_SOFT_CAP 100MB（超限
io_failed）；hello 拒绝与协议违例以 error 事件 + thread_state(dead, cause="protocol")
可观察。startup 建目录范围：agentDir 下 plugins/bin/bash-outputs/trash；
sessions 目录由 sessionsRoot 负责（不在 agentDir 下建 sessions/）。

（每线程并发 driving send 无独立上限——沿用现状记账语义，总量由
pendingCommandsCap 兜底。）

## 8. 错误码（26 项全集）

unknown_thread / thread_superseded / thread_not_live / session_unreadable /
already_open / thread_limit / streaming_window / invalid_input / unknown_command /
capability_thinking / capability_images / capability_plugin / images_too_many /
model_unavailable / cursor_stale / state_conflict / name_conflict / trust_required /
path_forbidden / io_failed / internal / bash_denied / protocol / compact_rejected /
plugin_install_failed / plugin_uninstall_failed

## 9. 四种消费方完整示例

### 9.1 服务端多住户（in-process）

```ts
const sdk = createSdkClient({
  mode: "in-process",
  agentDir: `${root}/${id}/agent`,
  sessionsRoot: `${root}/${id}/sessions`,
  mailboxRoot: `${root}/${id}/mailbox`,
  workflowRoot: `${root}/${id}/workflow`,
  env: tenantEnvSnapshot(id),
  limits: { maxThreads: 4, idleRetireMs: 300_000 },
  onEvent: (e) => bus.publish(id, e),
  onLog: (m) => logger.child(id).info(m),
});
```

### 9.2 桌面 app（worker 隔离）

```ts
const sdk = createSdkClient({ mode: "worker", agentDir, sessionsRoot, onEvent: dispatchToUI });
await sdk.startup();
const t = await sdk.resumeThread({ threadId: picked, cwd: projectRoot, trusted: true });
```

### 9.3 cli（in-process + REPL）

```ts
const sdk = createSdkClient({ mode: "in-process", agentDir, sessionsRoot,
  limits: { idleRetireMs: 0 }, onEvent: renderer.push });
const th = (await sdk.startThread({ cwd, trusted: true, dial })).value;
readline.on("line", (line) => {
  if (line.startsWith("/")) void th.runCommand(line);
  else void th.send(line);
});
```

### 9.4 host-hub stdio 薄壳

```ts
const sdk = createSdkClient({ mode: "worker", agentDir, sessionsRoot,
  onEvent: (e) => stdout.write(serializeFrame(e)),
  onLog: (m) => stderr.write(m) });
await sdk.startup();
stdin.on("data", (chunk) => adapter.feed(chunk, sdk));
```

帧序列化字节兼容锚定六处敏感点（DESIGN K11），快照测试锁定。
