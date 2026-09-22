// shell 词法封装：ExecEnv spawn 的逻辑 argv → srt 需要的命令文本。单引号词法（POSIX sh 安全）：
// 引号内除单引号外全字面；单引号以 `'\''` 闭合-转义-重开。exec 前缀让信号直达原 argv0（少一层壳）。

/** 单词封装：空串→''；含单引号→闭合转义 */
export function shellQuoteWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** argv → 命令文本（空 argv → 空串——调用方按 spawn 失败降级） */
export function commandOf(argv: readonly string[]): string {
  if (argv.length === 0) return "";
  return `exec ${argv.map(shellQuoteWord).join(" ")}`;
}
