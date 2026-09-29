import { extractStringField } from "./extract-string-field.ts";

export function extractLastEditText(raw: string): { readonly path?: string; readonly value?: string } {
  if (!raw.includes("\"edits\"")) return {};
  const lastNewText = lastFieldQuote(raw, "newText");
  if (lastNewText === undefined) return {};
  const value = scanStringFrom(raw, lastNewText);
  const head = prefixUpToKey(raw, "edits");
  const { path } = extractStringField(head, "path");
  return { path, value };
}

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
      if (raw[i] === "\"") last = i;
    }
    from = at + 1;
  }
}

function scanStringFrom(raw: string, start: number): string {
  let value = "";
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return value;
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const esc = raw[i + 1];
    if (esc === undefined) return value;
    if (esc === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return value;
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
  return value;
}

function prefixUpToKey(raw: string, key: string): string {
  const at = raw.indexOf(`"${key}"`);
  return at < 0 ? raw : raw.slice(0, at);
}
