// 半截 tool_use 参数的字符串字段提取（docs/TRUNCATED-TOOL-RESCUE.md 层 2）：输入是 llm 层
// 原文出口的半截 JSON 串（转义状态真实——修补版无法可靠提取）。手写扫描器按 JSON 转义规则
// 逐字符解码，截断点前的前缀解码确定性成立；write 传 "content"、edit 传 "new_string"。

/** 扫描终止形态：closed = 未转义闭合引号（字段完整，截断在更后的键）；eof = 输入耗尽（半截前缀） */
interface Scanned {
  readonly value: string;
  readonly closed: boolean;
}

/** 从 start（指向起始引号）解码到闭合引号或输入耗尽。\uXXXX 不足 4 位十六进制（截在转义序列
 *  中间）→ 丢弃该不完整序列（保守不猜）。裸控制字符（真实 \x00-\x1f 出现在字符串里——JSON
 *  非法但截断流会有）按原样收进前缀：与修补链「转义后丢键」的丢键行为有意不一致——本提取器
 *  吃的是原文，保真优先。 */
function scanString(raw: string, start: number): Scanned {
  let value = "";
  let i = start + 1; // 跳过起始引号
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return { value, closed: true };
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const esc = raw[i + 1]; // 反斜杠后无字符 = 转义序列截断，丢弃
    if (esc === undefined) return { value, closed: false };
    if (esc === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return { value, closed: false }; // \u 截在中间
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (esc === "b") value += "\b";
    else if (esc === "f") value += "\f";
    else if (esc === "n") value += "\n";
    else if (esc === "r") value += "\r";
    else if (esc === "t") value += "\t";
    else value += esc; // \" \\ \/ 及其它（无效转义按原字符收——保真）
    i += 2;
  }
  return { value, closed: false };
}

/** 定位 `"<field>"` 键：键名引号串 → 冒号 → 起始引号；找不到（截断在字段之前）→ undefined */
function locateValueQuote(raw: string, field: string): number | undefined {
  const key = `"${field}"`;
  let from = 0;
  for (;;) {
    const at = raw.indexOf(key, from);
    if (at < 0) return undefined;
    let i = at + key.length;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i += 1;
    if (raw[i] === ":") {
      i += 1;
      while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i += 1;
      if (raw[i] === '"') return i; // 值是字符串 → 命中；其它类型/截在冒号后 → 续找下一处键名
    }
    from = at + 1;
  }
}

/** 提取目标字段值与 path 字段：field 半截（引号未闭）→ value 为半截前缀；path 半截或缺失 →
 *  path undefined（无法命名目标）。字段完整但更后的键截断 → value 完整返回。 */
export function extractStringField(raw: string, field: string): { readonly path?: string; readonly value?: string } {
  const valueAt = locateValueQuote(raw, field);
  if (valueAt === undefined) return {}; // 无字段键/值非字符串/键名截断 → 无可抢救（path 单独在场不构成目标）
  const pathAt = locateValueQuote(raw, "path");
  if (pathAt === undefined) return { value: scanString(raw, valueAt).value };
  const path = scanString(raw, pathAt);
  if (!path.closed) return { value: scanString(raw, valueAt).value }; // path 半截 → 无法命名目标，不猜
  return { path: path.value, value: scanString(raw, valueAt).value };
}
