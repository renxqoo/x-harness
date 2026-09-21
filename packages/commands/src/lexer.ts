// 命令词法单源（BATCH3-DESIGN §2.1）：本仓 trim 语义 + 参照系词形。行首 `/` + 小写
// 开头词形 [a-z][a-z0-9_-]*；rawInput 词后原文逐字（不二次 trim）；`//x` 天然不命中
// （第二字符非 [a-z]）；`/Compact` 大写不命中（交模型）。

export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

const COMMAND_LEXER = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/u;

export function parseCommand(line: string): { name: string; rawInput: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("//")) return undefined;
  const match = COMMAND_LEXER.exec(trimmed);
  if (match === null) return undefined;
  // 名字后原文逐字（含分隔空白——参照系 rawInput 语义；消费方自行裁剪）
  return { name: match[1] ?? "", rawInput: trimmed.slice(match[0].length) };
}
