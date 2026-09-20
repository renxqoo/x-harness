// ⑦ 审计日志：全事件流落 JSONL 文件（逃生舱 + 宿主信任域 IO）。
// 真实场景：合规审计 / 事后调试回放。

import { appendFileSync } from "node:fs";
import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { tapSessionEvents } from "@x-harness/plugin-api";

export interface AuditLogOptions {
  /** 含事件 data 内容（默认 false——只记元数据；true 时完整审计但文件更大） */
  readonly includeData?: boolean;
}

export function auditLogPlugin(path: string, options: AuditLogOptions = {}): Plugin {
  return {
    name: "audit-log",
    apply: (ctx: Context): Disposer =>
      tapSessionEvents(ctx, (event, session) => {
        // 宿主信任域：插件代码可直接 fs（围栏约束模型驱动动作，不约束插件）
        const entry = {
          ts: Date.now(),
          session,
          type: event.type,
          seq: event.seq,
          ...(options.includeData === true ? { data: event.data } : {}),
        };
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      }),
  };
}
