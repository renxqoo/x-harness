import type { PermissionRule } from "../types.ts";

export function bashPrefixMatch(pattern: string, words: readonly string[], opts: { readonly nature?: string } = {}): boolean {
  if (pattern === "*") return opts.nature !== "grant";
  let body = pattern;
  let prefix = false;
  if (pattern.endsWith(":*")) {
    const stripped = pattern.slice(0, -2);
    const lastWord = stripped.split(/\s+/).filter((t) => t !== "").pop();
    if (lastWord === undefined || !lastWord.includes(":")) {
      body = stripped;
      prefix = true;
    }
  }
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  if (prefix) {
    if (words.length < tokens.length) return false;
    return tokens.every((token, i) => words[i] === token);
  }
  return words.length === tokens.length && tokens.every((token, i) => words[i] === token);
}

export function bashRuleMatches(rules: readonly PermissionRule[], words: readonly string[]): PermissionRule[] {
  return rules.filter((rule) => rule.tool === "Danger" && bashPrefixMatch(rule.pattern, words, { nature: rule.nature }));
}
