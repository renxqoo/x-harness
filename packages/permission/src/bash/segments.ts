// 复合命令段解析（docs/EXEC-ENV.md §5）：&&/||/;/|/换行/子壳拆段（引号内分隔符不拆）；
// 未闭合引号/括号 → unparseable（保守 ask）。dynamic = 真实 shell 会展开/通配的词：
// 未引用的 $/`/* 与**双引号内的 $/`**（会展开）都算——静态裁决不得建立在错误字面量假设上。
// 两遍：lex（词元/分隔符，携带原文 raw——重定向提取需要源文本）→ assemble（括号配深 + 段落成型）。

export interface Segment {
  /** 段内词元（剥引号保留字面） */
  readonly words: readonly string[];
  /** 存在真实 shell 会展开/通配的词——静态不可裁决 */
  readonly dynamic: boolean;
  /** 段原文（含空格/引号原样——重定向提取用） */
  readonly text: string;
}

export type ParseResult = { readonly ok: true; readonly segments: readonly Segment[] } | { readonly ok: false; readonly kind: "unparseable" };

type Lex =
  | { readonly kind: "word"; readonly text: string; readonly raw: string; readonly dynamic: boolean }
  | { readonly kind: "ws"; readonly raw: string }
  | { readonly kind: "sep"; readonly op: string; readonly raw: string; readonly opensParen: boolean; readonly closesParen: boolean };

const TWO_OPS = ["&&", "||"];
const ONE_OPS = [";", "|", "\n", "(", ")"];

/** 引号段读取：未闭合返回 undefined；单引号=真字面量，双引号含 $/` 会展开（dynamic） */
function readQuoted(command: string, i: number, quote: "'" | '"'): { readonly content: string; readonly dynamic: boolean; readonly next: number } | undefined {
  const end = command.indexOf(quote, i + 1);
  if (end < 0) return undefined;
  const inner = command.slice(i + 1, end);
  return { content: inner, dynamic: quote === '"' && /[$`]/.test(inner), next: end + 1 };
}

function lex(command: string): Lex[] | undefined {
  const out: Lex[] = [];
  let word = "";
  let wordRawStart = 0;
  let dynamic = false;
  const pushWord = (end: number): void => {
    if (word !== "") out.push({ kind: "word", text: word, raw: command.slice(wordRawStart, end), dynamic });
    word = "";
    dynamic = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (word === "") wordRawStart = i;
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(command, i, ch);
      if (quoted === undefined) return undefined; // 未闭合引号
      word += quoted.content;
      if (quoted.dynamic) dynamic = true;
      i = quoted.next;
      continue;
    }
    if (ch === "\\") {
      word += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (TWO_OPS.includes(two)) {
      pushWord(i);
      out.push({ kind: "sep", op: two, raw: two, opensParen: false, closesParen: false });
      i += 2;
      continue;
    }
    if (ONE_OPS.includes(ch)) {
      pushWord(i);
      out.push({ kind: "sep", op: ch, raw: ch, opensParen: ch === "(", closesParen: ch === ")" });
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord(i);
      out.push({ kind: "ws", raw: ch });
      i += 1;
      continue;
    }
    if (/[$`*]/.test(ch)) dynamic = true; // 未引用展开/通配
    word += ch;
    i += 1;
  }
  pushWord(i);
  return out;
}

/** lex 流 → 段：括号配深（子壳叶子段各自裁决）；闭而无开/开而无闭 → unparseable */
function assemble(lexes: readonly Lex[]): ParseResult {
  const segments: Segment[] = [];
  let words: string[] = [];
  let dynamic = false;
  let text = "";
  let depth = 0;
  const flush = (): void => {
    const trimmed = text.trim();
    if (trimmed !== "" || words.length > 0) {
      segments.push({ words: words.filter((w) => w !== ""), dynamic, text: trimmed });
    }
    words = [];
    dynamic = false;
    text = "";
  };
  for (const item of lexes) {
    if (item.kind === "word") {
      words.push(item.text);
      if (item.dynamic) dynamic = true;
      text += item.raw;
      continue;
    }
    if (item.kind === "ws") {
      text += item.raw; // 空白入原文
      continue;
    }
    if (item.opensParen) {
      depth += 1;
      text += item.raw; // 括号入原文
      continue;
    }
    if (item.closesParen) {
      depth -= 1;
      if (depth < 0) return { ok: false, kind: "unparseable" }; // 闭而无开
      text += item.raw;
      continue;
    }
    flush(); // &&/||/;/|/换行：段切断（切断符不入段原文）
  }
  if (depth !== 0) return { ok: false, kind: "unparseable" }; // 开而无闭
  flush();
  return { ok: true, segments };
}

export function parseSegments(command: string): ParseResult {
  const lexes = lex(command);
  if (lexes === undefined) return { ok: false, kind: "unparseable" };
  return assemble(lexes);
}
