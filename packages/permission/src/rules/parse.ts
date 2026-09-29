import type { PermissionRule, RuleOrigin, RuleTool, Verdict } from "../types.ts";

const TOOLS: readonly RuleTool[] = ["Danger", "Read", "Write", "Tool"];
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
