// edits[] 数组感知提取（EDIT-TOOL 批 4——rescue 对 edit 工具真形态的适配）：截断点
// 大概率在最后的 in-flight 条目（与 pi-events「截断只可能命中最后一个 in-flight 块」
// 同推论），定位 edits 数组内**最后一个** "newText" 键做前缀提取；path 仍顶层单键
// （限定在 "edits" 键之前的顶层段——防数组内嵌对象误命中）。

import { extractStringField } from "./extract-string-field.ts";

/** 半截 edit 参数原文 → 末条 newText 前缀 + path。无 edits 键 / 无 newText → 让位；
 *  path 半截或缺失 → path undefined（无法命名目标）。 */
export function extractLastEditText(raw: string): { readonly path?: string; readonly value?: string } {
  if (!raw.includes("\"edits\"")) return {}; // 无 edits 键 = 形态不符（edit 真形态必含）→ 让位
  const lastNewText = lastFieldQuote(raw, "newText");
  if (lastNewText === undefined) return {};
  const value = scanStringFrom(raw, lastNewText);
  const head = prefixUpToKey(raw, "edits");
  const { path } = extractStringField(head, "path");
  return { path, value };
}

/** 定位最后一个 "<field>": 值起始引号（含冒号两侧空白——与 locateValueQuote 同宽容度） */
function lastFieldQuote(raw: string, field: string): number | undefined {
  const key = `"${field}"`;
  let from = 0;
  let last: number | undefined;
  for (;;) {
    const at = raw.indexOf(key, from);
    if (at < 0) return last;
    let i = at + key.length;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i += 1;
    if (raw[i] === ":") {
      i += 1;
      while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i += 1;
      if (raw[i] === "\"") last = i; // 值是字符串 → 记录（继续找更后的）
    }
    from = at + 1;
  }
}

/** 从起始引号做 JSON 字符串扫描（转义解码 + 半截前缀——extract-string-field 同语义的单点内联） */
function scanStringFrom(raw: string, start: number): string {
  let value = "";
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return value; // 闭合（该条 newText 完整——截断在更后）
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const esc = raw[i + 1];
    if (esc === undefined) return value; // 反斜杠截尾
    if (esc === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return value; // \u 半截
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (esc === "n") value += "\n";
    else if (esc === "t") value += "\t";
    else if (esc === "r") value += "\r";
    else if (esc === "b") value += "\b";
    else if (esc === "f") value += "\f";
    else value += esc;
    i += 2;
  }
  return value; // 输入耗尽——半截前缀
}

/** 截到 "<key>" 首次出现之前（path 提取的顶层段限定） */
function prefixUpToKey(raw: string, key: string): string {
  const at = raw.indexOf(`"${key}"`);
  return at < 0 ? raw : raw.slice(0, at);
}
