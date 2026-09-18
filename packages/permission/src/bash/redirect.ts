// 重定向算符提取（docs/EXEC-EXEC.md §5 管线第 4 步）：算符全矩阵 > >> 2> 2>> &> > & ；2>&1 是
// fd 复制无新目标（不裁决）；>/dev/null 属围栏许可字面（allow）。目标裁决（界内 allow / 越根 ask）
// 在 adjudicate 合成——本模块只提取。

export interface Redirect {
  readonly op: ">" | ">>" | "2>" | "2>>" | "&>" | "2>&1";
  readonly target: string | undefined; // 2>&1 恒 undefined
}

const REDIRECT_RE = /(?:2>>|2>|&>>|&>|>>|>)\s*([^\s;|&)]+)|(2>&1)/g;

export function redirectsOf(segmentText: string): Redirect[] {
  const out: Redirect[] = [];
  for (const match of segmentText.matchAll(REDIRECT_RE)) {
    if (match[2] !== undefined) {
      out.push({ op: "2>&1", target: undefined });
      continue;
    }
    const raw = match[0] as string;
    const target = match[1] as string;
    out.push({ op: opOf(raw), target });
  }
  return out;
}

export const DEV_NULL = "/dev/null";

const OP_WORD = /^(?:2>>|2>|&>>|&>|>>|>|2>&1)$/;

const OP_PREFIX = /^(2>>|2>|&>>|&>|>>|>)/;

/** 规则匹配用词元：剔除重定向算符及其目标——含算符与目标熔接的单词（>/dev/null）；
 *  前缀规则匹配命令本体，不含 redirection 语法 */
export function withoutRedirects(words: readonly string[]): string[] {
  const out: string[] = [];
  let skipTarget = false;
  for (const word of words) {
    if (OP_WORD.test(word)) {
      skipTarget = word !== "2>&1"; // 2>&1 无文件目标
      continue;
    }
    if (skipTarget) {
      skipTarget = false;
      continue;
    }
    if (OP_PREFIX.test(word) && word !== "2>&1") continue; // 熔接形 >/dev/null、>>log.txt
    out.push(word);
  }
  return out;
}

function opOf(raw: string): Redirect["op"] {
  if (raw.startsWith("2>>")) return "2>>";
  if (raw.startsWith("2>")) return "2>";
  if (raw.startsWith("&>")) return "&>"; // &>> 归 &>（追加双流——裁决语义同形）
  if (raw.startsWith(">>")) return ">>";
  return ">";
}
