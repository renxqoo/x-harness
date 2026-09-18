// darwin Seatbelt 剖面（docs/EXEC-ENV.md §4）：argv 改写器——sandbox-exec -p <SBPL> 包裹逻辑 argv。
// 剖面：deny default + process-exec 全放 + file-read 全放（denyRead 子路径拒——具体子路径规则
// 优先于泛规则，SBPL 语义 e2e 实测锁定）+ writable 逐段 allow write + /dev/null 字面 +
// protectedPaths deny-write + 网络仅放本会话代理回环口（unix socket 随 deny default 全拒——
// docker.sock 逃逸口封死）。

import { homedir } from "node:os";
import type { Fence } from "../fence.ts";
import { denyReadPaths } from "../fence.ts";

/** SBPL subpath 匹配是词法的（实测）——经 symlink 的路径必须词法/物理双形都放行/拒 */
export type RealpathOf = (p: string) => string;

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
  const fence = input.fence;
  const proxyPort = input.proxyPort;
  const lines: string[] = ["(version 1)", "(deny default)", "(allow process-fork)", "(allow process-exec*)"];
  for (const d of denyReadPaths(fence, home)) {
    for (const f of forms(d, realpathOf)) lines.push(`(deny file-read* (subpath "${f}"))`);
  }
  lines.push("(allow file-read*)");
  lines.push('(allow file-write* (literal "/dev/null"))');
  for (const w of fence.writable) {
    for (const f of forms(w, realpathOf)) lines.push(`(allow file-write* (subpath "${f}"))`);
  }
  for (const p of fence.protectedPaths) {
    for (const f of forms(p, realpathOf)) lines.push(`(deny file-write* (subpath "${f}"))`);
  }
  if (fence.network === "off") {
    lines.push("(deny network*)"); // 显式重复（deny default 已含）——剖面自述
  } else if (proxyPort !== undefined) {
    // 远端过滤 host 只接受 * / localhost（实测：127.0.0.1 字面量被拒）——localhost 限回环本会话代理口
    lines.push(`(allow network-outbound (remote ip "localhost:${String(proxyPort)}"))`);
  }
  return lines.join("\n");
}

export interface SeatbeltArgvInput {
  readonly fence: Fence;
  readonly proxyPort: number | undefined;
  readonly argv: readonly string[];
  readonly home?: string;
  readonly realpathOf?: RealpathOf;
}

export function seatbeltArgv(input: SeatbeltArgvInput): readonly string[] {
  return ["sandbox-exec", "-p", seatbeltProfile(input), "--", ...input.argv];
}
