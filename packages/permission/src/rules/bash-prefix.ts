// Bash 前缀规则匹配（docs/EXEC-ENV.md §5）：`git commit:*` 命中 `git commit -m x`、不命中 `git push`；
// 裸 `git status` 只精确命中同词元序列（不命中 `git status -s`）；`*` 万配。
// 词元短于 pattern 前缀永不命中。

import type { PermissionRule } from "../types.ts";

export function bashPrefixMatch(pattern: string, words: readonly string[]): boolean {
  if (pattern === "*") return true;
  const prefix = pattern.endsWith(":*");
  const tokens = (prefix ? pattern.slice(0, -2) : pattern).split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  if (prefix) {
    if (words.length < tokens.length) return false;
    return tokens.every((token, i) => words[i] === token);
  }
  return words.length === tokens.length && tokens.every((token, i) => words[i] === token);
}

/** Bash 规则族匹配：返回全部命中规则（deny 压过 allow 由调用方按裁决序处理） */
export function bashRuleMatches(rules: readonly PermissionRule[], words: readonly string[]): PermissionRule[] {
  return rules.filter((rule) => rule.tool === "Bash" && bashPrefixMatch(rule.pattern, words));
}
