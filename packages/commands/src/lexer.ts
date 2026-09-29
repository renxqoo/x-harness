export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

const COMMAND_LEXER = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/u;

export function parseCommand(line: string): { name: string; rawInput: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("//")) return undefined;
  const match = COMMAND_LEXER.exec(trimmed);
  if (match === null) return undefined;
  return { name: match[1] ?? "", rawInput: trimmed.slice(match[0].length) };
}
