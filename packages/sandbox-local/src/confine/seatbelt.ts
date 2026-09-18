// darwin Seatbelt 剖面（docs/EXEC-ENV.md §4）：argv 改写器——sandbox-exec -p <SBPL> 包裹逻辑 argv。
// 剖面：deny default + process-exec 全放 + file-read 全放（denyRead 子路径拒——具体子路径规则
// 优先于泛规则，SBPL 语义 e2e 实测锁定）+ writable 逐段 allow write + /dev/null 字面 +
// protectedPaths deny-write + 网络仅放本会话代理回环口（unix socket 随 deny default 全拒——
// docker.sock 逃逸口封死）。

import { homedir } from "node:os";
import type { Fence } from "../fence.ts";
import { denyReadPaths } from "../fence.ts";

export function seatbeltProfile(fence: Fence, proxyPort: number | undefined, home: string = homedir()): string {
  const lines: string[] = ["(version 1)", "(deny default)", "(allow process-exec*)"];
  for (const d of denyReadPaths(fence, home)) lines.push(`(deny file-read* (subpath "${d}"))`);
  lines.push("(allow file-read*)");
  lines.push('(allow file-write* (literal "/dev/null"))');
  for (const w of fence.writable) lines.push(`(allow file-write* (subpath "${w}"))`);
  for (const p of fence.protectedPaths) lines.push(`(deny file-write* (subpath "${p}"))`);
  if (fence.network === "off") {
    lines.push("(deny network*)"); // 显式重复（deny default 已含）——剖面自述
  } else if (proxyPort !== undefined) {
    lines.push(`(allow network-outbound (remote ip-loopback (port "${String(proxyPort)}")))`);
  }
  return lines.join("\n");
}

export interface SeatbeltArgvInput {
  readonly fence: Fence;
  readonly proxyPort: number | undefined;
  readonly argv: readonly string[];
  readonly home?: string;
}

export function seatbeltArgv(input: SeatbeltArgvInput): readonly string[] {
  const home = input.home === undefined ? homedir() : input.home;
  return ["sandbox-exec", "-p", seatbeltProfile(input.fence, input.proxyPort, home), "--", ...input.argv];
}
