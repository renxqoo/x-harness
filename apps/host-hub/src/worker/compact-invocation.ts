// 行首 /compact 拦截（DESIGN §3.2）：词法单源在 hub（内核无命令注册面——trim 后
// 行首斜杠、小写词形 [a-z0-9-]+；`//` 不解析）；解析名恰为 compact 即等价 compact
// 命令（args 即附加指示，trim 已由解析器完成）。大小写/非词形不命中 → 交回
// followup（大写 → conversation；其他合法词形未注册 → 同为 conversation）。
export interface InterceptResult {
  intercepted: boolean;
  customInstructions?: string;
}

const COMMAND_LEXER = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("//")) return undefined;
  const match = COMMAND_LEXER.exec(trimmed);
  if (match === null) return undefined;
  return { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

export function interceptCompact(message: string): InterceptResult {
  const parsed = parseSlashCommand(message);
  if (parsed === undefined || parsed.name !== "compact") return { intercepted: false };
  return {
    intercepted: true,
    ...(parsed.args !== "" ? { customInstructions: parsed.args } : {}),
  };
}
