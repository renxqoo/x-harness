interface Scanned {
  readonly value: string;
  readonly closed: boolean;
}

function scanString(raw: string, start: number): Scanned {
  let value = "";
  let i = start + 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') return { value, closed: true };
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const esc = raw[i + 1];
    if (esc === undefined) return { value, closed: false };
    if (esc === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return { value, closed: false };
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (esc === "b") value += "\b";
    else if (esc === "f") value += "\f";
    else if (esc === "n") value += "\n";
    else if (esc === "r") value += "\r";
    else if (esc === "t") value += "\t";
    else value += esc;
    i += 2;
  }
  return { value, closed: false };
}

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
      if (raw[i] === '"') return i;
    }
    from = at + 1;
  }
}

export function extractStringField(raw: string, field: string): { readonly path?: string; readonly value?: string } {
  const valueAt = locateValueQuote(raw, field);
  if (valueAt === undefined) return {};
  const pathAt = locateValueQuote(raw, "path");
  if (pathAt === undefined) return { value: scanString(raw, valueAt).value };
  const path = scanString(raw, pathAt);
  if (!path.closed) return { value: scanString(raw, valueAt).value };
  return { path: path.value, value: scanString(raw, valueAt).value };
}
