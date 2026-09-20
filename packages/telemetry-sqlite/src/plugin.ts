// 插件装配（docs/TELEMETRY-SQLITE.md §1.1/§1.5）：装载期 ensureSchema（fail-fast——DDL/版本
// 门失败即插件装载失败）；订阅四 token（created/audit/flush/disposed）+ provide 查询服务。
// 四路屏障对齐 session-persistence-jsonl 纪律：teardown 先 sessionAuditDrain.drain()（残余
// 审计事件入账）→ 拆监听 → drainAll 终排空；sessionFlush 经 parallel 等待排空段（fail-closed
// 上浮进 store.flush Result）；contextDisposing 由 session 桥接排空审计队列 + 本插件 teardown
// 由 loadPlugins 层回卷兜底（drainAll 在监听拆除后跑——teardown 期新事件不重不丢）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionAuditDrain, sessionAuditEvent, sessionCreated, sessionDisposed, sessionFlush, sessionStore } from "@x-harness/session";
import { ensureSchema } from "./schema.ts";
import { createQueryService } from "./service.ts";
import type { SqliteTelemetryOptions, TelemetryQueryService } from "./types.ts";
import { createTelemetryWriter } from "./writer.ts";

/** 能力 seam（S6 裁决：service token + ctx.provide 即能力面——零地基改动） */
export const sqliteTelemetry = defineService<TelemetryQueryService>("sqlite-telemetry");

export function sqliteTelemetryPlugin(options: SqliteTelemetryOptions): Plugin {
  return {
    name: "telemetry-sqlite",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      ensureSchema(options.db); // fail-fast：版本不符/DDL 失败 → 插件装载失败（§1.4）

      const store = ctx.use(sessionStore);
      const writer = createTelemetryWriter({
        db: options.db,
        tx: options.tx,
        resource: options.resource,
        includeBodies: options.includeBodies ?? true,
        onIoError:
          options.onIoError ??
          ((message: string) => {
            process.stderr.write(`${message}\n`);
          }),
      });

      const offs = [
        ctx.on(sessionCreated, ({ header }) => {
          // 首灌 = 构造期全量（seed 前缀 + end-seed）；created 广播先于该会话一切审计投递
          writer.onCreated(header, store.get(header.id)?.events() ?? []);
        }),
        ctx.on(sessionAuditEvent, ({ session, event }) => {
          writer.onAuditEvent(session, event);
        }),
        ctx.on(sessionFlush, ({ session }) => writer.flush(session)),
        ctx.on(sessionDisposed, ({ session }) => {
          writer.onDisposed(session);
        }),
      ];

      const offProvide = ctx.provide(sqliteTelemetry, createQueryService(options.db));

      return () => {
        // 残余审计事件先入账再拆监听（与 jsonl 同款原子面——drain 端口同步排空，不与微任务投递重复）
        ctx.tryUse(sessionAuditDrain)?.drain();
        for (const off of [...offs, offProvide]) off();
        return writer.drainAll();
      };
    },
  };
}
