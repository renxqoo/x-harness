// Bash 前缀规则匹配（docs/EXEC-ENV.md §5）：`git commit:*` 命中 `git commit -m x`、不命中 `git push`；
// 裸 `git status` 只精确命中同词元序列（不命中 `git status -s`）；`*` 万配。
// 词元短于 pattern 前缀永不命中。
// 前缀形判定（2026-09-29 红队 P1-4）：尾 `:*` 剥离后尾词必须不含 `:`——旧 endsWith(":*") 把
// 命令原文含词内冒号的形态（`echo deploy:*`）也剥尾前缀化，习得后泛化放行 `echo deploy x`。
// 独立词 ` :*`（前有空格）剥尾后尾词为空串被滤——恒为前缀形（`git push :*` 的 :* 是通配标记）。
// 万配对习得不命中（防御面）：习得闸生产面已拒万配落账——匹配面双保险（grant 形 `*` 不放行）。

import type { PermissionRule } from "../types.ts";

export function bashPrefixMatch(pattern: string, words: readonly string[], opts: { readonly nature?: string } = {}): boolean {
  if (pattern === "*") return opts.nature !== "grant"; // 万配不匹配习得规则（习得只经 exactRule/泛化建议落账，无万配形）
  let body = pattern;
  let prefix = false;
  if (pattern.endsWith(":*")) {
    const stripped = pattern.slice(0, -2);
    const lastWord = stripped.split(/\s+/).filter((t) => t !== "").pop();
    if (lastWord === undefined || !lastWord.includes(":")) {
      body = stripped; // 尾词干净（git status:* / git push :*）——合法前缀形
      prefix = true;
    } // 尾词含冒号（echo deploy:*）——命令原文精确形，不剥
  }
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  if (prefix) {
    if (words.length < tokens.length) return false;
    return tokens.every((token, i) => words[i] === token);
  }
  return words.length === tokens.length && tokens.every((token, i) => words[i] === token);
}

/** Bash 规则族匹配：返回全部命中规则（deny 压过 allow 由调用方按裁决序处理） */
export function bashRuleMatches(rules: readonly PermissionRule[], words: readonly string[]): PermissionRule[] {
  return rules.filter((rule) => rule.tool === "Danger" && bashPrefixMatch(rule.pattern, words, { nature: rule.nature }));
}
