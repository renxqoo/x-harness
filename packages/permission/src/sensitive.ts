// argv 敏感面执法（docs/PERMISSION-V2-DESIGN.md U12/§4.3——直通档的内核防线补偿）：
// bash argv 文件实参命中拒读表/保护写面 → 强制 ask（精确规则可记忆）。fenced 档不消费
// 本面（srt 内核同表执法，矩阵行=contained 不问）。重定向输入面/输出越根面在
// adjudicate 既有面，此处只补 argv 实参这一层。

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "./bash/ast.ts";
import { globMatch } from "./rules/glob.ts";

// 保护面目录感知匹配（P-bug-5）：裸目录 pattern（宿主传入 `<dir>/plugins` 形）只命中
// 目录自身——嵌套文件 `dir/plugins/evil.sh` 漏网。附加递归通配形态双查；已有通配的
// pattern 不受影响（叠加后语义等价）
export function protectGlobMatch(pattern: string, path: string, root: string): boolean {
  if (globMatch(pattern, path, root)) return true;
  const dirPattern = pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
  return globMatch(dirPattern, path, root);
}

/** 归一候选：绝对/~/相对三类词面（~user 形不可解析 → 视为敏感保守问） */
function candidatePaths(word: string, root: string): string[] {
  if (word === "~") return [homedir()];
  if (word.startsWith("~/")) return [resolve(homedir(), word.slice(2))];
  if (/^~[A-Za-z0-9_.-]/.test(word)) return []; // ~other/... 不可静态解析——调用面保守标记
  if (word.startsWith("/")) return [resolve(word)];
  return [resolve(root, word)]; // 相对/裸词（**/.env 类相对 glob 射程含裸文件名）
}

/** 单命令敏感命中：argv 实参与重定向目标双面扫描（echo x >> settings 的写向量在重定向面） */
interface DenyTables {
  readonly protectedWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
}

function commandSensitiveHit(cmd: ParsedCommand, root: string, tables: DenyTables): { readonly kind: "deny-read" | "protect-write"; readonly pattern: string } | undefined {
  const words: string[] = cmd.argv.slice(1);
  for (const redirect of cmd.redirects) {
    if (redirect.target !== undefined && redirect.target !== "/dev/null") words.push(redirect.target);
  }
  for (const raw of words) {
    if (raw === "") continue;
    // 旗值归一（对抗审查 #15）：剥 - 前缀/@ 载载前缀/key= 取值后扫描；纯旗名（无值面）跳过
    let word = raw;
    if (word.startsWith("-")) {
      const body = word.replace(/^-+/, "");
      const eq = body.indexOf("=");
      if (eq === -1) continue; // 纯旗名（-o 的值在下一词位，由该词自扫）
      word = body.slice(eq + 1);
    }
    if (word.startsWith("@")) word = word.slice(1); // curl -d @file 载荷路径
    if (word === "") continue;
    if (/^~[A-Za-z0-9_.-]/.test(word)) return { kind: "deny-read", pattern: word }; // ~user 保守敏感
    for (const path of candidatePaths(word, root)) {
      const readHit = tables.denyRead.find((pattern: string) => globMatch(pattern, path, root));
      if (readHit !== undefined) return { kind: "deny-read", pattern: readHit };
      const writeHit = [...tables.denyWrite, ...tables.protectedWrite].find((pattern: string) => protectGlobMatch(pattern, path, root));
      if (writeHit !== undefined) return { kind: "protect-write", pattern: writeHit };
    }
  }
  return undefined;
}

/** 管线 argv/重定向敏感面：任一段命中即敏感（读面与写面同向保守） */
export function argvSensitiveHit(
  commands: readonly ParsedCommand[],
  root: string,
  tables: DenyTables = { protectedWrite: [], denyRead: [], denyWrite: [] },
): { readonly kind: "deny-read" | "protect-write"; readonly pattern: string } | undefined {
  for (const cmd of commands) {
    const hit = commandSensitiveHit(cmd, root, tables);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
