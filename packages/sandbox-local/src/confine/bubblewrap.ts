// linux bwrap 剖面（docs/EXEC-ENV.md §4）：argv 改写器。ro-bind / + writable 逐目录 bind +
// denyRead/protectedPaths 以 --tmpfs 遮挂（读得空目录=拒读语义——bwrap 无 deny-read 动词）+
// --unshare-pid --die-with-parent + 网络 off/--unshare-net；allowlist 档经 --unshare-net +
// 代理 unix socket bind-mount + socat 网络命名空间内回环桥（Claude Code 同款 socat 依赖）。
// socat 为后台兄弟（组长退出后由 env settle 兜底 KILL——接受 ≤5s 收尾税，方案 §4）。

import { homedir } from "node:os";
import { join } from "node:path";
import type { Fence } from "../fence.ts";
import { denyReadPaths } from "../fence.ts";

export const PROXY_SOCKET_DIR = "/.x-harness-proxy";
export const PROXY_LOOPBACK_PORT = 18080;

export interface BwrapArgvInput {
  readonly fence: Fence;
  readonly proxyMounted: boolean;
  readonly argv: readonly string[];
  readonly home?: string;
}

export function bwrapArgv(input: BwrapArgvInput): readonly string[] {
  const home = input.home === undefined ? homedir() : input.home;
  const out: string[] = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--unshare-pid", "--unshare-net"];
  if (input.proxyMounted) out.push("--bind", PROXY_SOCKET_DIR, PROXY_SOCKET_DIR); // 代理 unix socket 桥接挂载点
  for (const w of input.fence.writable) out.push("--bind", w, w);
  for (const d of [...denyReadPaths(input.fence, home), ...input.fence.protectedPaths]) out.push("--tmpfs", d); // 遮挂=拒读/拒写
  out.push("--");
  if (input.proxyMounted) {
    // socat 后台兄弟：ns 内回环:18080 → 挂载的 unix socket；命令以 exec 接管组长位
    const socat = `socat TCP-LISTEN:${String(PROXY_LOOPBACK_PORT)},fork,reuseaddr UNIX-CONNECT:${join(PROXY_SOCKET_DIR, "sock")} &`;
    out.push("/bin/sh", "-c", `${socat} exec ${quote(input.argv)}`);
  } else {
    out.push(...input.argv);
  }
  return out;
}

/** argv 安全拼接进 sh -c（单引号包裹，内嵌单引号转义） */
function quote(argv: readonly string[]): string {
  return argv.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}
