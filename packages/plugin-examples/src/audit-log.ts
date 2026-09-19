// ⑦ 审计日志：全事件流落 JSONL 文件（逃生舱 + 宿主信任域 IO）。
// 真实场景：合规审计 / 事后调试回放。

import { appendFileSync } from "node:fs";
import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { tapSessionEvents } from "@x-harness/plugin-api";

export function auditLogPlugin(path: string): Plugin {
  return {
    name: "audit-log",
    apply: (ctx: Context): Disposer =>
      tapSessionEvents(ctx, (event, session) => {
        // 宿主信任域：插件代码可直接 fs（围栏约束模型驱动动作，不约束插件）
        appendFileSync(path, `${JSON.stringify({ ts: Date.now(), session, type: event.type, seq: event.seq })}\n`);
      }),
  };
}
