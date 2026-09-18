// darwin Seatbelt 剖面（docs/EXEC-ENV.md §4）：argv 改写器——sandbox-exec -p <SBPL> 包裹逻辑 argv。
// 实测语义（darwin 25.5 逐项验证，处置见 EXEC-ENV.md §13）：
// - subpath 过滤器只对 allow file-write* 有效且为词法匹配（symlink 根需词法/物理双形）；
//   对 deny 一律不可用（deny-read 无效；deny-write 带过滤器必杀全写）——受保护路径的内核写拒
//   在 darwin 不可表达，执法归工具面（permission Write 规则）；Fence.protectedPaths 仅 linux
//   --tmpfs 遮挂消费。
// - deny file-read* 仅非锚定 regex 有效（^/$ 锚定破损、subpath 无效）——非锚定子串天然覆盖
//   词法/物理双形（/private/var 包含 /var）。
// - (allow process-fork) 必需（deny default 封 fork）；网络远端过滤 host 只收 */localhost。

import { homedir } from "node:os";
import type { Fence } from "../fence.ts";
import { denyReadPaths } from "../fence.ts";

export type RealpathOf = (p: string) => string;

/** SBPL 双层转义：regex 元字符 + SBPL 字符串字面量（" 与反斜杠） */
const REGEX_META = /[.[*+?(){}|^$[]/g; // 字符类内 [ 与 * 均为字面量

function regexLiteral(text: string): string {
  const regexEscaped = text.replace(REGEX_META, (ch) => `\\${ch}`);
  return regexEscaped.replace(/"/g, '\\"');
}

function sbplString(text: string): string {
  return text.replace(/"/g, '\\"');
}

/** SBPL subpath 词法匹配——经 symlink 的路径词法/物理双形放行 */
function forms(p: string, realpathOf: RealpathOf): readonly string[] {
  const real = realpathOf(p);
  return real === p ? [p] : [p, real];
}

export interface SeatbeltProfileInput {
  readonly fence: Fence;
  readonly proxyPort: number | undefined;
  readonly home?: string;
  readonly realpathOf?: RealpathOf;
}

export function seatbeltProfile(input: SeatbeltProfileInput): string {
  const home = input.home === undefined ? homedir() : input.home;
  const realpathOf = input.realpathOf ?? ((p: string) => p);
  const lines: string[] = ["(version 1)", "(deny default)", "(allow process-fork)", "(allow process-exec*)"];
  lines.push("(allow file-read*)");
  for (const d of denyReadPaths(input.fence, home)) {
    // 非锚定子串（尾斜杠目录前缀）——实测唯一有效的拒读形态；双形天然覆盖
    lines.push(`(deny file-read* (regex "${regexLiteral(`${d}/`)}"))`);
  }
  lines.push('(allow file-write* (literal "/dev/null"))');
  for (const w of input.fence.writable) {
    for (const f of forms(w, realpathOf)) lines.push(`(allow file-write* (subpath "${sbplString(f)}"))`);
  }
  if (input.fence.network === "off") {
    lines.push("(deny network*)"); // 显式重复（deny default 已含）——剖面自述
  } else if (input.proxyPort !== undefined) {
    lines.push(`(allow network-outbound (remote ip "localhost:${String(input.proxyPort)}"))`);
  }
  return lines.join("\n");
}

export interface SeatbeltArgvInput {
  readonly fence: Fence;
  readonly proxyPort: number | undefined;
  readonly argv: readonly string[];
  readonly home?: string;
  readonly realpathOf?: RealpathOf;
  /** wrapper 绝对路径（probe 产物；缺省 PATH 名） */
  readonly wrapper?: string;
}

export function seatbeltArgv(input: SeatbeltArgvInput): readonly string[] {
  const home = input.home === undefined ? homedir() : input.home;
  const { fence, proxyPort, argv, realpathOf, wrapper } = input;
  return [wrapper ?? "sandbox-exec", "-p", seatbeltProfile({ fence, proxyPort, home, realpathOf }), "--", ...argv];
}
