import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import type { AssistantSettlement } from "@x-harness/agent-loop";
import { transformAssistant, textBlocksOf } from "@x-harness/plugin-api";

export interface JsonEnforcerOptions {
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
        if (fenced === raw && !raw.startsWith("{") && !raw.startsWith("[")) return s;
        try {
          const value: unknown = JSON.parse(fenced);
          if (!validate(value)) return s;
          const rest = s.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
          return { content: [...rest, { type: "text", text: JSON.stringify(value) }], stopReason: s.stopReason };
        } catch {
          return s;
        }
      }),
  };
}
