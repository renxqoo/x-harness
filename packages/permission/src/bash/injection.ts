// 注入检测（docs/EXEC-ENV.md §5 管线第 1 步）：压过一切 allowlist——命中即 ask（reason injection）。
// 8 形（my-agent 对照）：命令替换/反引号/网络管道入 shell/find -exec/xargs 入 shell/eval/
// base64 解码入 shell/env 赋值替换 + `$<`。对原文匹配（引号内也命中——保守优先）。

export type InjectionKind =
  | "command-substitution"
  | "backtick"
  | "net-pipe-shell"
  | "find-exec"
  | "xargs-shell"
  | "eval"
  | "base64-shell"
  | "env-substitution"
  | "fd-substitution";

const SHELL = /(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|a)?sh\b/;
const PATTERNS: readonly (readonly [InjectionKind, RegExp])[] = [
  ["command-substitution", /\$\(/, ],
  ["backtick", /`[^`]*`/, ],
  ["net-pipe-shell", new RegExp(String.raw`\b(?:curl|wget|fetch)\b[^|;&]*\|\s*${SHELL.source}`)],
  ["find-exec", /\bfind\b[^;|&]*\s-exec\w*\b/],
  ["xargs-shell", new RegExp(String.raw`\bxargs\b[^|;&]*(?:\|\s*${SHELL.source}|\s+(?:\/(?:usr\/)?bin\/)?(?:ba|z|)sh\b)`)],
  ["eval", /(^|[\s;&|(])eval\s/],
  ["base64-shell", new RegExp(String.raw`\bbase64\b[^|;&]*\|\s*${SHELL.source}`)],
  ["env-substitution", /(^|[\s;|&])\w+=\$\(|\benv\s+\w+=\$/],
  ["fd-substitution", /\$</],
];

/** 命中返回注入类别名；良性命令（git status && npm test / 普通重定向）不命中 */
export function detectInjection(command: string): InjectionKind | undefined {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(command)) return kind;
  }
  return undefined;
}
