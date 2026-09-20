// ⑩ 轻量记忆：turn 收尾把最后一条 user/assistant 摘要写盘；下一步领取时按关键词注入命中行。
// 已知局限（设计选择——"lite" 定位）：只提取 text 块、不存 tool 结果；完整记忆需持久状态 seam。
// 真实场景：跨 turn 的"记住我之前说过"（宿主信任域持久化——能力插件模式中的 state 自建示范）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { tapSessionEvents, transformMessages } from "@x-harness/plugin-api";
import type { InboxEntry, SessionEvent } from "@x-harness/session";

export interface MemoryLiteOptions {
  readonly store: string; // 文件路径（宿主决定落点）
  readonly maxLines?: number;
}

export function memoryLitePlugin(options: MemoryLiteOptions): Plugin {
  const maxLines = options.maxLines ?? 50;
  return {
    name: "memory-lite",
    apply: (ctx: Context): Disposer => {
      const read = (): string[] => {
        if (!existsSync(options.store)) return [];
        return readFileSync(options.store, "utf8").split("\n").filter((l) => l !== "");
      };
      const write = (lines: readonly string[]): void => {
        mkdirSync(dirname(options.store), { recursive: true });
        writeFileSync(options.store, `${lines.slice(-maxLines).join("\n")}\n`);
      };
      let lastUser = "";
      const offTap = tapSessionEvents(ctx, (event: SessionEvent) => {
        if (event.type === "user/message") {
          lastUser = ((event.data as { content?: readonly { type: string; text?: string }[] }).content ?? [])
            .map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(" ").slice(0, 80);
        }
        if (event.type === "assistant/message" && lastUser !== "") {
          const answer = ((event.data as { content?: readonly { type: string; text?: string }[] }).content ?? [])
            .map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(" ").slice(0, 80);
          write([...read(), `Q: ${lastUser} => A: ${answer}`]);
          lastUser = "";
        }
      });
      const offInject = transformMessages(ctx, (claim: readonly InboxEntry[]): readonly InboxEntry[] => {
        const query = claim.map((e) => e.content.map((b) => (b.type === "text" ? (b as { text: string }).text : "")).join(" ")).join(" ");
        const words = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
        const hits = read().filter((line) => words.some((w) => line.toLowerCase().includes(w))).slice(0, 3);
        if (hits.length === 0) return claim;
        const memory: InboxEntry = { id: `memory-${String(Date.now())}`, content: [{ type: "text", text: `Relevant memory (memory-lite):\n${hits.join("\n")}` } as { type: "text"; text: string }] };
        return [memory, ...claim];
      });
      return () => {
        offInject();
        offTap();
      };
    },
  };
}
