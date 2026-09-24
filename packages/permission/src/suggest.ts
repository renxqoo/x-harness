// 泛化建议器（docs/PERMISSION-V2-DESIGN.md §5.2）：ask 批准 → 最窄有用规则建议。
// 边界铁律：wrapper（bash -c/env/sudo 前缀）、解释器字符串载荷（node -e/python -c）、
// opaque/结构失败/动态形态一律不泛化（返回 undefined——弹窗无建议，记忆退化精确全串）。

import type { ParsedCommand } from "./bash/ast.ts";

/** 解释器/wrapper 家族——argv0 命中即只允许精确记忆（-e/-c 载荷=任意代码，泛化=永续宽规则） */
const NO_GENERALIZE: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "env", "sudo", "doas", "su", "exec", "nohup", "time",
  "node", "deno", "bun", "python", "python3", "perl", "ruby", "php", "osascript", "awk", "sed", "xargs", "eval",
]);

function basenameOf(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

/** 建议规则串（完整规则形态——可直接 parseRules 落账）：单命令 + 全段静态 + 非解释器
 *  家族 → `Bash(argv0 sub:*):allow` 或 `Bash(argv0:*):allow`；
 *  多段管线/解释器/带敏感形态 → undefined（不泛化）。 */
export function suggestRule(parsed: { readonly commands: readonly ParsedCommand[] }): string | undefined {
  if (parsed.commands.length !== 1) return undefined; // 管线不泛化——段间组合语义宽
  const cmd = parsed.commands[0];
  if (cmd === undefined || cmd.argv.length === 0) return undefined;
  if (cmd.dynamic || cmd.injection !== undefined || cmd.ask !== undefined || cmd.opaque !== undefined) return undefined;
  const verb = cmd.argv[0] ?? "";
  const base = basenameOf(verb);
  if (NO_GENERALIZE.has(base)) return undefined;
  if (cmd.argv[0] !== base) return undefined; // 带路径形态（/usr/bin/x）不泛化——环境差异面
  const sub = cmd.argv[1];
  if (sub !== undefined && !sub.startsWith("-") && !sub.includes("/")) return `Bash(${base} ${sub}:*):allow`;
  return `Bash(${base}:*):allow`;
}

/** 精确记忆兜底：不泛化形态的落账串（全命令原文——最窄） */
export function exactRule(command: string): string {
  return `Bash(${command}):allow`;
}
