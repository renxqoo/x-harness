# telemetry-sqlite 方案

> 状态：已实施（B1–B4 完成 + B5 收口：四门中 typecheck/lint/单测绿，e2e 环境故障与本包无关——见提交说明）
> 级别：中（模板 B：方案 + 实施两节）
> 来源：会话裁决 2026-09-20（替代 plugin-examples/src/audit-log.ts 的生产路径）
> 状态机：草稿 → 定稿 → 已实施 → 已核销；定稿后改动在提交说明里记录原因

## 0. 背景与定位

`plugin-examples/src/audit-log.ts` 是 tapSessionEvents 的演示插件（appendFileSync
逐事件同步写、错误被 emit sink 静默吞掉、无 fsync/锁/恢复），不可生产。
本包按 SDK-DESIGN「能力插件」形态（S6 裁决：telemetry 不进内核，service token +
ctx.provide 即 seam）提供生产级本地遥测：**OTel 数据模型/语义约定建模 + SQLite 落库**，
不引入 @opentelemetry/* SDK 依赖（用户裁决 1A：本地落库场景 SDK exporter 体系是负资产；
仓内无既有 OTel 契约需要继承——T2D 文档为空占位，SDK-DESIGN §6/§7 契约草案已降级删除）。

## 1. 契约

### 1.1 包与 API

新包 `packages/telemetry-sqlite`（`@x-harness/telemetry-sqlite`，private workspace）。
依赖方向：`@x-harness/core`、`@x-harness/session`、`@x-harness/plugin-api`；
`bun:sqlite` 只出现在 `executor.ts` 单文件。

```ts
/** 宿主提供的 sqlite 执行面——连接归宿主，插件只拿执行器（e2e SqliteDb 契约同款形态） */
export interface SqliteExecutor {
  /** 预编译执行：INSERT/UPDATE/CREATE 等，返回变更行数 */
  run(sql: string, params?: readonly SqlValue[]): { changes: number | bigint };
  /** 预编译查询：SELECT 返回全部行 */
  all<T extends Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
}
export type SqlValue = null | number | string | bigint | Uint8Array;

/** 事务边界（可选提供；缺省时批次退化为逐条 run——测试替身用） */
export interface SqliteTx {
  begin(): void;
  commit(): void;
  rollback(): void;
}

export interface TelemetryResource {
  readonly serviceName: string;
  readonly version?: string;
  /** OTel resource attributes（deployment.environment 等），JSON 序列化入库 */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface SqliteTelemetryOptions {
  readonly db: SqliteExecutor;
  readonly tx?: SqliteTx;
  readonly resource: TelemetryResource;
  /** OTel logs body 全量保真开关（用户裁决 3C；缺省 true） */
  readonly includeBodies?: boolean;
  /** fire-and-forget 路径（created 首灌/disposed 终排空/实时段失败）的 I/O 失败上报；缺省 stderr */
  readonly onIoError?: (message: string) => void;
}

export interface TelemetryQueryService {
  /** 会话的 span 树（start_ms 序；children 按 start 嵌套） */
  spansOf(sessionId: string): SpanRow[];
  /** 会话的 log 流（seq 序） */
  logsOf(sessionId: string): LogRow[];
  /** 会话 token 用量（span attributes 的 gen_ai.usage 聚合；无 llm span 时 undefined） */
  usageOf(sessionId: string): { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number } | undefined;
  /** 用户裁决 4A：手动留存治理（级联删三表该会话行）；返回删除行数 */
  deleteSession(sessionId: string): number;
}

export const sqliteTelemetry = defineService<TelemetryQueryService>("sqlite-telemetry");

/** 插件名 "telemetry-sqlite"；inject: ["session"]；provide sqliteTelemetry */
export function sqliteTelemetryPlugin(options: SqliteTelemetryOptions): Plugin;

/** 内置 bun:sqlite 执行器（宿主自持连接时的免写面；WAL + synchronous=FULL + busy_timeout 在此统一设置） */
export function createBunSqliteExecutor(db: InstanceType<typeof import("bun:sqlite").Database>): SqliteExecutor & { tx: SqliteTx };
```

### 1.2 Schema（DDL 由插件装载时幂等执行；`schema_version` 表 fail-closed）

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
-- 非空且 != 1 → 装载失败抛错（未来格式迁移时递增 + 迁移函数；现在只认 1）

CREATE TABLE IF NOT EXISTS otel_sessions (
  session_id TEXT PRIMARY KEY,
  trace_id   TEXT NOT NULL,          -- hex-32 自铸（mintSessionId 非 hex，不能借用）
  created_ms INTEGER NOT NULL,
  header     TEXT NOT NULL           -- SessionHeader 原文 JSON（保真）
);

CREATE TABLE IF NOT EXISTS otel_spans (
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,      -- hex-16 自铸
  parent_span_id TEXT,               -- NULL = trace 根（session span）
  session_id     TEXT NOT NULL,
  name           TEXT NOT NULL,      -- "session" | "turn" | "step" | "tool.<name>" | "llm.chat"
  kind           TEXT NOT NULL,      -- INTERNAL | CLIENT（OTel SpanKind 子集，词表闭合）
  start_ms       INTEGER NOT NULL,   -- SessionEvent.time（ms，不假装 ns）
  end_ms         INTEGER,            -- NULL = 未闭合（崩溃可见；恢复配对后补）
  status_code    TEXT,               -- OK | ERROR | UNSET（词表闭合）
  status_message TEXT,
  attributes     TEXT NOT NULL,      -- JSON：OTel 语义属性（gen_ai.* 等）
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS idx_spans_session ON otel_spans(session_id, start_ms);

CREATE TABLE IF NOT EXISTS otel_logs (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,       -- SessionEvent.seq（per-session 单调）——幂等键
  ts_ms      INTEGER NOT NULL,
  trace_id   TEXT NOT NULL,
  span_id    TEXT,                   -- 归属 span（可空：session 级事件）
  severity   TEXT NOT NULL,          -- INFO | WARN | ERROR（词表闭合）
  event_type TEXT NOT NULL,          -- 17 词条原 type
  body       TEXT,                   -- 原始 SessionEvent 完整 JSON；includeBodies=false 时 NULL
  PRIMARY KEY (session_id, seq)
);
```

### 1.3 事件 → OTel 映射（fold，唯一权威词表）

| Session 事件 | 产出 |
| --- | --- |
| （sessionCreated） | span `session`（INTERNAL，trace 根，start=header.createdAt）+ `otel_sessions` 行 |
| `turn/start`…`turn/end` | span `turn`（INTERNAL，session span 之下）；end 事件 data.reason → status：completed=OK；error=ERROR+message；其余（aborted/blocked/max-tokens/interrupted）=UNSET+reason 属性 |
| `step/start`…`step/end` | span `step`（INTERNAL，turn 之下） |
| `tool/call`…`tool/result`（callId 配对） | span `tool.<name>`（CLIENT，step 之下）；attributes：`tool.call_id`、`tool.arguments`（原串保真）；result.isError → status ERROR + `tool.result` 摘要属性 |
| `request/header` | 更新当前 step 的 llm 请求属性（gen_ai.request.model / temperature / max_tokens / thinking；工具表计数不逐个展开）——**不立即可写 span**：llm span 的开写锚是 assistant 落账或 attempt（attempt 级拆分，用户裁决 2C） |
| `request/context` | 同上更新（gen_ai.system=provider、context_window 属性） |
| `assistant/message` | span `llm.chat`（CLIENT，step 之下）开启并闭合：attributes 含 request/* + `gen_ai.usage.*`（input/output/cache_read/cache_write **全字段透传**，undefined 字段省略——不复制 token-meter 丢缓存字段的形态）；status=OK（interrupted=true → UNSET）；start_ms 取该 step 首 request/header 的 ts（无则 assistant.message ts） |
| `assistant/attempt` | 独立 span `llm.chat`（CLIENT）：status=ERROR（message=attempt.error），有 usage 则照透传——失败尝试的已收 usage 不丢 |
| `llm/retry` | 归属当前 llm span 的 OTel span event（等价 attributes：retry.index/delay_ms/failure.*），另发 WARN 级 log |
| 其余消息/快照类事件 | log record（INFO；`tool/result.isError` → ERROR） |

- severity 映射闭合表：`tool/result{isError}` → ERROR；`llm/retry`、`assistant/attempt` → WARN；其余 → INFO。
- fold 是带游标增量状态机（token-meter 同款：增量 == 全量由同一 applyEvent 保证）；
  打开时从 `otel_spans WHERE end_ms IS NULL` + `otel_logs` 尾 seq 重建状态（resume 补 end）。

### 1.4 错误形态

- 装载期：schema_version 不符 / DDL 失败 → apply 抛错（fail-fast，插件装载失败）。
- 运行期写失败：事务失败置 degraded 闩 + `onIoError("telemetry-write-failed:<session>:<err>")`
  一次（降级周期去重），事件滞留 pending 按序重试；屏障成功解闩。
  **错误不经 emit sink 静默**（这是对 audit-log 的根性修正）。
- flush 路径失败经 sessionFlush parallel 聚合上抛 → store.flush Result 失败（fail-closed）。

### 1.5 副作用与事件时序

- 订阅：sessionCreated / sessionAuditEvent（tap 通道）/ sessionFlush / sessionDisposed；
  provide sqliteTelemetry。
- 一切磁盘写只经**单全局串行链**（sqlite 单连接；pending 缓冲 → 链上段 = 单事务批写）。
- 四路屏障（对齐 session-persistence-jsonl 纪律）：teardown 先 `sessionAuditDrain.drain()`
  → 拆监听 → 终排空（链上残余段完成后 resolve）；sessionFlush 经 parallel 等待排空段；
  contextDisposing 排空残余（监听器全存活窗口）。
- created 首灌：sessionCreated 时 pending 初始化为 store 全量日志（构造期 seed 前缀 +
  end-seed 经此入账），与 jsonl 同款「created 必先于一切审计投递」窗口假设。

## 2. 问题域

- **处理**：Session 事件流 → OTel span/log 行的增量折叠、幂等落库、崩溃后 resume 补配对、
  按 flush 屏障的持久性承诺、只读查询面、手动按会话删除。
- **不处理**（归属写清）：
  - 自动留存/过期清理 → 宿主用 deleteSession 自管（用户裁决 4A；「删审计数据」是合规决策，插件不代做）；
  - OTLP 导出/远程 collector → 未来独立 exporter 插件（本包词表为其上游）；
  - UI 渲染 → sessionEvent 同步面（宿主自留）；
  - token 计费口径（缓存折半等）→ token-meter 包（本包只透传原始 usage，不折算）；
  - worker 插件桥接 → 宿主经 pluginManager tokens 显式注册（SESSION.md §1.1）。
- **晚装载 fail-closed**：插件晚于会话创建装载时，该会话只入 pending 不写库；
  flush 报 `telemetry-unopened:<id>` 失败——与 jsonl writer-unopened 同款，不静默补灌。

## 3. 并发/一致性预算

- 定时器：**0 个**（不给进程续命；合批靠微任务天然批次——审计通道每批投递完即入链一段）。
- 串行链：单全局一条；段 = 单事务；单事务批大小上界 = pending 快照长度（无分片——
  本地 sqlite 单事务 10⁴ 行内是毫秒级，数据量级不到分批流式的分水岭）。
- 内存上界：pending ≈ 未落库事件 × 单事件 JSON 体积；degraded 积压上限无硬顶
  （与 jsonl 一致——屏障语义保证 flush 收口，进程内不无限增长的义务由 flush 纪律承担）。
- 幂等：`(session_id, seq)` 主键 + INSERT OR IGNORE；span `INSERT OR REPLACE`
  （start 先写 end 后补）；重放/重复投递不产生重复行。
- 一 session 一 writer 的进程内约束下，跨进程共写同一库文件超出本包义务
  （busy_timeout 兜短暂竞争；文档写明单进程部署前提）。

## 4. 拆分

```
packages/telemetry-sqlite/src/
  types.ts        # SqliteExecutor/SqliteTx/SqlValue/行类型/词表闭合常量
  executor.ts     # createBunSqliteExecutor（bun:sqlite 唯一触点 + pragmas + tx 实现）
  schema.ts       # DDL 数组 + ensureSchema（版本校验）
  ids.ts          # hex trace/span 铸造（crypto 随机）
  fold.ts         # 纯函数状态机：events → span/log 行（增量==全量）；resume 重建
  writer.ts       # pending + 单链 + 事务批写 + degraded 闩
  plugin.ts       # 装配：订阅四 token + provide query service + 四路屏障
  query.ts        # TelemetryQueryService 实现
  index.ts        # barrel
  __test__/       # 分层测试（见测试口径）
```

依赖方向：plugin → writer → fold/schema/ids → types；executor 独立（宿主可选）。
`plugin-examples/src/audit-log.ts` 删除；`index.ts` 导出与 examples 测试改指新插件
（教学职责由本包 README + 测试承担）。

## 5. 实施顺序（每阶段独立提交、四门全绿、批次对抗审查）

1. **B1 地基**：types + ids + schema + executor + 单测（DDL 幂等/版本 fail-closed/pragma）。
2. **B2 fold**：状态机全量单测（17 词条 × 映射表逐行、配对、resume 重建、usage 透传）。
3. **B3 writer+plugin**：集成测（临时真库）：幂等重放、degraded、flush 屏障、
   unload 排空、晚装载 fail-closed、created 首灌。
4. **B4 query + 替换删除**：query 单测；examples 测试改指、audit-log.ts 删除、README。
5. **B5 收口**：全量回归 + 假绿抽查 + 本文档状态推进 已核销。

过渡态：B3 完成前 examples 的 audit-log 仍在（旧测试绿）；B4 单轨收口（旧文件删净）。

## 6. 裁决

- 用户裁决 1A：不引入 @opentelemetry/* SDK，按规范语义自定词表。
- 用户裁决 2C：llm span 拆到 attempt 级（失败重试逐次可见，fold 复杂度接受）。
- 用户裁决 3C：includeBodies 缺省 true（全量保真），false 时 body 列 NULL 只存投影。
- 用户裁决 4A：留存治理只做 deleteSession 手动面，无自动清理。
- 默认裁决（否决窗口已过）：trace_id/span_id hex 自铸；包名 telemetry-sqlite；
  audit-log.ts 删除单轨；词表闭合常量 + 测试锁死（导出枚举 == 文档词表双向封闭）。

## 7. 测试口径

- **契约级**：词表闭合（severity/status/kind 导出常量 == 本文档 §1.2/§1.3 词表，
  双向遍历断言）；DDL 快照（表/列/主键/索引 == §1.2）；fold 映射表逐行表驱动
  （17 词条 × 期望 span/log 产出矩阵，新增表项自动获得覆盖）。
- **边界与异常**：空会话（0 事件）；includeBodies=false 的 body NULL；
  垃圾 usage（token-meter validUsage 同款垃圾输入不崩）；未配对 tool/call（崩溃态）→
  end_ms NULL 保留；同 seq 重放幂等；超长 arguments 串；schema_version=99 装载拒绝。
- **并发/时序**：批内交错（审计微任务批 → 单事务）；flush 等待在飞段；投递中退订
  （unload 窗口事件不重不丢——drain 兜底）；degraded 恢复后按序补写（乱序卷不可达）；
  created 前到达的审计事件（理论窗口）入 pending 不崩。
- **resume/崩溃**：写一半的库重开（spawn 真库 kill 模拟）→ 未闭 span 补 end、
  无重复行；fork 子会话（同 prefix 不同 id）互不串。
- **表驱动**：TurnEndReason 六变体 → status 映射矩阵；severity 闭合表矩阵。
- **分层**：unit（fold/ids/schema）→ 集成（writer+plugin 临时真库）→
  examples 改造后的 world 级测试（makeTestWorld 挂新插件跑 turn 断言 span/log 落库）。
- **e2e**：`bun run e2e` 已有独立 sqlite 场景（crud），本包不跨进程边界
  （同进程插件 + 本地库），不新增 e2e 旅程——判定依据 SKILL.md §7「单测够不到的接缝」
  在本包不存在（bun:sqlite 在 vitest node 环境经 Bun 运行时可达性由 executor 单测背书）。

## 8. 验收清单

- [ ] §1.1 API 逐条（SqliteExecutor/tx 可选/includeBodies/onIoError 缺省/query 四面）
- [ ] §1.2 DDL 快照断言 + schema_version fail-closed
- [ ] §1.3 映射表逐行（表驱动）+ usage 四字段透传（cache_read/cache_write 不丢）
- [ ] §1.4 degraded 去重上报 + flush fail-closed 上浮 + 装载期 fail-fast
- [ ] §1.5 四路屏障 + 单链 + 首灌窗口
- [ ] §2 晚装载 fail-closed（telemetry-unopened）
- [ ] §3 预算：0 定时器 / 幂等重放 / 乱序卷不可达
- [ ] audit-log.ts 删净（index 导出 + 测试改指，无双轨）
- [ ] 四门全绿 + 覆盖率 ≥90/85（数字如实报告）+ 对抗审查问题清零
- [ ] 执行环境约束处置记录（bun panic 诊断结论，见 §5 B1 提交说明）
