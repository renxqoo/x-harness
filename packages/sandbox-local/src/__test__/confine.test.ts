// 剖面构造内容级断言（docs/EXEC-ENV.md §4/§7——dsh profile dialects 同款强度）：
// SBPL 行序/writable 逐段//dev/null 字面/拒读子路径/网络口字面量；bwrap ro-bind/命名空间/
// writable bind/tmpfs 遮挂/socat 桥模板/argv 引号转义。

import { describe, expect, it } from "vitest";
import { seatbeltProfile, seatbeltArgv } from "../confine/seatbelt.ts";
import { bwrapArgv, PROXY_LOOPBACK_PORT } from "../confine/bubblewrap.ts";
import type { Fence } from "../fence.ts";

const fence = (over: Partial<Fence> = {}): Fence => ({
  writable: ["/w/app", "/tmp"],
  denyRead: ["~/.ssh"],
  protectedPaths: ["/w/app/.xh-config"],
  network: { allowedDomains: ["a.com"] },
  ...over,
});

describe("seatbeltProfile（SBPL 内容级）", () => {
  it("剖面骨架：deny default 先行 + exec/read 全放 + writable 逐段 + /dev/null 字面 + 拒读子路径", () => {
    const sbpl = seatbeltProfile(fence(), 8085, "/Users/demo");
    const lines = sbpl.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(deny default)");
    expect(lines).toContain("(allow process-exec*)");
    expect(lines.indexOf('(deny file-read* (subpath "/Users/demo/.ssh"))')).toBeLessThan(lines.indexOf("(allow file-read*)")); // 拒读先于全放（具体优先）
    expect(lines).toContain('(allow file-write* (literal "/dev/null"))');
    expect(lines).toContain('(allow file-write* (subpath "/w/app"))');
    expect(lines).toContain('(allow file-write* (subpath "/tmp"))');
    expect(lines).toContain('(deny file-write* (subpath "/w/app/.xh-config"))'); // 受保护路径写拒
    expect(lines).toContain('(allow network-outbound (remote ip-loopback (port "8085")))'); // 仅本会话代理口
    expect(sbpl).not.toContain("allow network*"); // 无泛网络放行
  });

  it("network off：显式 deny network*、无代理口", () => {
    const sbpl = seatbeltProfile(fence({ network: "off" }), undefined, "/Users/demo");
    expect(sbpl).toContain("(deny network*)");
    expect(sbpl).not.toContain("network-outbound");
  });

  it("seatbeltArgv：sandbox-exec -p 前缀 + 逻辑 argv 原样后缀", () => {
    const argv = seatbeltArgv({ fence: fence(), proxyPort: 8085, argv: ["/bin/sh", "-c", "ls"], home: "/Users/demo" });
    expect(argv.slice(0, 2)).toEqual(["sandbox-exec", "-p"]);
    expect(argv[3]).toBe("--");
    expect(argv.slice(4)).toEqual(["/bin/sh", "-c", "ls"]);
  });
});

describe("bwrapArgv（linux 剖面内容级）", () => {
  it("骨架：ro-bind / + dev/proc + die-with-parent + 双 unshare + writable bind + 遮挂", () => {
    const argv = bwrapArgv({ fence: fence(), proxyMounted: false, argv: ["/bin/sh", "-c", "ls"], home: "/Users/demo" });
    const head = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--unshare-pid", "--unshare-net"];
    expect(argv.slice(0, head.length)).toEqual(head);
    const flat = argv.join(" ");
    expect(flat).toContain("--bind /w/app /w/app");
    expect(flat).toContain("--tmpfs /Users/demo/.ssh"); // 拒读遮挂
    expect(flat).toContain("--tmpfs /w/app/.xh-config"); // 受保护遮挂
    expect(argv[argv.length - 4]).toBe("--"); // 逻辑 argv 原样（off 档无 socat）
    expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
  });

  it("allowlist 档：代理 socket bind + socat 回环桥 + exec 接管组长位", () => {
    const argv = bwrapArgv({ fence: fence(), proxyMounted: true, argv: ["/bin/sh", "-c", "ls -la"], home: "/Users/demo" });
    const flat = argv.join(" ");
    expect(flat).toContain("--bind /.x-harness-proxy /.x-harness-proxy");
    expect(flat).toContain(`socat TCP-LISTEN:${String(PROXY_LOOPBACK_PORT)},fork,reuseaddr UNIX-CONNECT:/.x-harness-proxy/sock &`);
    expect(flat).toContain("exec '/bin/sh' '-c' 'ls -la'"); // 逻辑 argv 引号包裹拼接
    // 单引号转义：含内嵌单引号的参数不逃逸
    const tricky = bwrapArgv({ fence: fence(), proxyMounted: true, argv: ["echo", "it's"], home: "/Users/demo" });
    expect(tricky.join(" ")).toContain(`exec 'echo' 'it'\\''s'`);
  });
});
