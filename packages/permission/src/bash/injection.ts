// 注入类别词汇（docs/EXEC-ENV.md §14.2/§14.3）：6 kind。command-substitution 由 AST
// command_substitution/process_substitution 节点触发（$() / 反引号 / 双引号内嵌 / 赋值右值 /
// 数组 / heredoc 体——吸收旧 backtick、env-substitution 两形）；net-pipe-shell / base64-shell
// 由 pipeline 结构判定（末位 shell + 上游抓取器，basename 归一）；find-exec / xargs-shell 由
// payload 规则触发（空载荷——wrappers 层）；eval 是动态载荷兜底。$< 形已删：grammar 产出
// ERROR → unparseable，终态同 ask。

export type InjectionKind = "command-substitution" | "net-pipe-shell" | "find-exec" | "xargs-shell" | "eval" | "base64-shell";

/** 管道判定：末位 shell 解释器（basename 归一后匹配——/usr/bin/curl | sh 不漏） */
export const PIPE_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** 解释器家族（wrappers 旗面规则与管道 stdin 判定共用）：-c 字面量再解析（bash 族）/
 *  文件操作数/stdin/赋值前缀 → opaque */
export const INTERPRETER_FAMILY: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "node", "bun", "deno", "python", "python3", "ruby", "perl", "php",
]);

/** 解释器名判定（含 python3.11 类版本后缀形——与家族集精确匹配互补） */
export function isInterpreterName(base: string): boolean {
  return INTERPRETER_FAMILY.has(base) || /^python\d/.test(base);
}

/** 管道判定：上游抓取器/解码器 → 注入类别 */
export const PIPE_FETCHERS: ReadonlyMap<string, InjectionKind> = new Map([
  ["curl", "net-pipe-shell"],
  ["wget", "net-pipe-shell"],
  ["fetch", "net-pipe-shell"],
  ["base64", "base64-shell"],
]);
