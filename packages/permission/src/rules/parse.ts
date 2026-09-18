// 规则字符串解析（docs/EXEC-ENV.md §5）：`Tool(pattern):verdict`；词法开放但拼错 fail-closed 拒启
// （构造期 throw——宿主起不来优于静默错配）。空 pattern 拒。

import type { PermissionRule, RuleOrigin, RuleTool, Verdict } from "../types.ts";

const TOOLS: readonly RuleTool[] = ["Bash", "Read", "Write", "Grep"];
const VERDICTS: readonly Verdict[] = ["allow", "deny", "ask"];

export function parseRule(text: string, origin: RuleOrigin): PermissionRule {
  const close = text.lastIndexOf("):");
  if (close <= 0) throw new Error(`permission: unparseable rule: ${text}`);
  const tool = text.slice(0, text.indexOf("("));
  if (!(TOOLS as readonly string[]).includes(tool)) throw new Error(`permission: unknown tool in rule: ${text}`);
  const verdict = text.slice(close + 2);
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error(`permission: unknown verdict in rule: ${text}`);
  const pattern = text.slice(text.indexOf("(") + 1, close);
  if (pattern === "") throw new Error(`permission: empty pattern in rule: ${text}`);
  return { tool: tool as RuleTool, pattern, verdict: verdict as Verdict, origin };
}

export function parseRules(texts: readonly string[], origin: RuleOrigin): PermissionRule[] {
  return texts.map((text) => parseRule(text, origin));
}
