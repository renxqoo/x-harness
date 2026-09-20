# @x-harness/telemetry-sqlite

本地遥测插件：Session 事件流 → OTel 数据模型 → SQLite 落库（生产级替代旧 audit-log 演示）。
规格：`docs/TELEMETRY-SQLITE.md`。

## 形态

能力插件（SDK-DESIGN S6 裁决）：service token `sqliteTelemetry` + `ctx.provide` 即 seam，
内核零改动。宿主持有 sqlite 连接，插件只拿 `SqliteExecutor` 执行面。

```ts
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor, sqliteTelemetryPlugin } from "@x-harness/telemetry-sqlite";

const db = new Database("telemetry.db");
const exec = createBunSqliteExecutor(db); // WAL + synchronous=FULL + busy_timeout 统一设置
await loadPlugins(ctx, [
  sessionPlugin,
  sqliteTelemetryPlugin({ db: exec, tx: exec.tx, resource: { serviceName: "my-app", version: "1.0" } }),
]);

// 查询面（同进程）
const telemetry = ctx.use(sqliteTelemetry);
telemetry.spansOf(sessionId);   // span 树（start_ms, rowid 序）
telemetry.logsOf(sessionId);    // log 流（seq 序；body=原始事件 JSON）
telemetry.usageOf(sessionId);   // token 用量聚合（input/output/cacheRead/cacheWrite）
telemetry.deleteSession(sessionId); // 手动留存治理（级联删三表）
```

## 数据模型（OTel 语义约定）

- `otel_sessions`：trace_id 映射 + SessionHeader 原文 JSON
- `otel_spans`：`session` → `turn` → `step` → (`llm.chat` | `tool.<name>`)；attributes 含
  `gen_ai.*`（请求/usage 四字段透传——缓存不丢）、`tool.*`、`xh.*` 锚属性
- `otel_logs`：17 词条全量投影（`event_type` + body 原文；`includeBodies=false` 时 body NULL）

## 纪律（对 audit-log 的根性修正）

- 错误不静默：写失败置 degraded 闩 + `onIoError` 一次（降级周期去重）；flush 屏障 fail-closed
  上浮进 `store.flush` Result
- 一切磁盘写经单全局串行链（段 = 单事务批写）；0 定时器
- 幂等：log `(session_id, seq)` OR IGNORE 首行胜出；span 开行 OR IGNORE + 闭行 UPDATE
  （REPLACE 会重排 rowid 破坏树形序）
- resume 续链：同库重开复用 trace/span id，未闭 span 保留（崩溃可见）
- 晚装载 fail-closed：created 未达的会话只入 pending，flush 报 `telemetry-unopened`
- 单进程部署前提（跨进程共写同一库文件超出本包义务——busy_timeout 只兜短暂竞争）

## 测试

`src/__test__/`：foundation（B1 词表/DDL/版本门/executor）→ fold（B2 映射表逐行表驱动）→
plugin（B3 集成：幂等重放/degraded/flush 屏障/unload 排空/晚装载/created 首灌/resume 续链）；
world 级验证在 `plugin-examples`（⑦ 用例）。
