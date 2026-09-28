// 泛化建议器（docs/PERMISSION-V2-DESIGN.md §5.2）：ask 批准 → 最窄有用规则建议。
// 边界铁律：wrapper（bash -c/env/sudo 前缀）、解释器字符串载荷（node -e/python -c）、
// opaque/结构失败/动态形态一律不泛化（返回 undefined——弹窗无建议，记忆退化精确全串）。

import type { ParsedCommand } from "./bash/ast.ts";

// 解释器/wrapper 家族——argv0 命中即只允许精确记忆（-e/-c 载荷=任意代码，泛化=永续宽规则）。
// 词面单源（B-dup-2 卫生）：解释器族/提权族取 injection 与 hard-deny 的表；本表只补
// 传输/流编辑等记忆安全特有的词（env/nohup/time/exec/awk/sed/xargs/eval/osascript）
import { INTERPRETER_FAMILY } from "./bash/injection.ts";
import { SUDO_LIKE } from "./bash/hard-deny.ts";

const NO_GENERALIZE_EXTRA: ReadonlySet<string> = new Set([
  "env", "nohup", "time", "exec", "awk", "sed", "xargs", "eval", "osascript", "source", ".",
]);
const NO_GENERALIZE: ReadonlySet<string> = new Set([...INTERPRETER_FAMILY, ...SUDO_LIKE, ...NO_GENERALIZE_EXTRA]);

/** 剥壳前原始首词守卫（P2-7）：parseBash 已剥 env/nohup/time 等传输前缀——旧判据只看
 *  剥后 argv0，`env GIT_SSH_COMMAND=x git push` 泛化成 git push:* 后习得规则覆盖任意
 *  env 变体（比批准面宽）。原始首词在 NO_GENERALIZE → 不泛化（精确全串径） */
function rawHeadBanned(cmd: ParsedCommand): boolean {
  const head = basenameOf((cmd.raw ?? "").trim().split(/\s+/)[0] ?? "");
  return head !== "" && NO_GENERALIZE.has(head);
}

function basenameOf(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

/** 建议规则串（完整规则形态——可直接 parseRules 落账）：单命令 + 全段静态 + 非解释器
 *  家族 → `Danger(argv0 sub:*):allow` 或 `Danger(argv0:*):allow`；
 *  多段管线/解释器/带敏感形态 → undefined（不泛化）。 */
export function suggestRule(parsed: { readonly commands: readonly ParsedCommand[] }): string | undefined {
  if (parsed.commands.length !== 1) return undefined; // 管线不泛化——段间组合语义宽
  const cmd = parsed.commands[0];
  if (cmd === undefined || cmd.argv.length === 0) return undefined;
  if (cmd.dynamic || cmd.injection !== undefined || cmd.ask !== undefined || cmd.opaque !== undefined) return undefined;
  // P2-7（2026-09-28）：剥壳前词守卫（rawHeadBanned）+ 剥后 argv0 守卫——双门都不泛化
  if (rawHeadBanned(cmd)) return undefined;
  const base = basenameOf(cmd.argv[0] ?? "");
  if (NO_GENERALIZE.has(base)) return undefined;
  if (cmd.argv[0] !== base) return undefined; // 带路径形态（/usr/bin/x）不泛化——环境差异面
  const sub = cmd.argv[1];
  if (sub !== undefined && !sub.startsWith("-") && !sub.includes("/")) return `Danger(${base} ${sub}:*):allow`;
  return `Danger(${base}:*):allow`;
}

/** 精确记忆兜底：不泛化形态的落账串（全命令原文——最窄）。
 *  含 ":*" 子串原文拒记（2026-09-29 红队 P1-4）：`echo deploy:*` 原文落账后与规则前缀
 *  语法同构，匹配面不可区分——泛化放行 `echo deploy x`；拒记退化每次问（可用性损失换安全） */
export function exactRule(command: string): string | undefined {
  if (/\s:?\*/.test(command) || command.includes(":*")) return undefined; // 原文含通配语法形——不可安全精确记忆
  return `Danger(${command}):allow`;
}
