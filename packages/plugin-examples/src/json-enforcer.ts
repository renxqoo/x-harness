// ⑧ 结构化输出：transformAssistant 剥离 markdown 围栏 + 校验 JSON（可注入校验器）。
// 真实场景：下游系统需要机器可读的 assistant 输出。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import type { AssistantSettlement } from "@x-harness/agent-loop";
import { transformAssistant, textBlocksOf } from "@x-harness/plugin-api";

export interface JsonEnforcerOptions {
  /** 自定义校验（缺省 JSON.parse 可解析即可） */
  readonly validate?: (value: unknown) => boolean;
}

export function jsonEnforcerPlugin(options: JsonEnforcerOptions = {}): Plugin {
  const validate = options.validate ?? ((): boolean => true);
  return {
    name: "json-enforcer",
    apply: (ctx: Context): Disposer =>
      transformAssistant(ctx, (s: AssistantSettlement): AssistantSettlement => {
        const texts = textBlocksOf(s.content);
        if (texts.length !== 1) return s;
        const raw = texts[0]?.text.trim() ?? "";
        const fenced = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        if (fenced === raw && !raw.startsWith("{") && !raw.startsWith("[")) return s; // 非 JSON 输出不碰
        try {
          const value: unknown = JSON.parse(fenced);
          if (!validate(value)) return s;
          const rest = s.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
          return { content: [...rest, { type: "text", text: JSON.stringify(value) }], stopReason: s.stopReason };
        } catch {
          return s; // 解析失败不碰（修复责任归注入纠偏类插件）
        }
      }),
  };
}
