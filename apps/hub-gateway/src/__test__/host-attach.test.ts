import { describe, expect, it, vi } from "vitest";
import { HostAttach, resolveHostBin } from "../host-attach.ts";

function fakeExec(): { command: string; args: string[] } {
  const self = new URL("./echo-host.ts", import.meta.url).pathname;
  return { command: process.execPath, args: [self] };
}

describe("resolveHostBin", () => {
  it("显式配置优先；缺省解析仓库入口；不可解析拒启（E7 回归：不得把 gateway 自身当 host）", () => {
    expect(resolveHostBin("/opt/host").command).toBe("/opt/host");
    const resolved = resolveHostBin(null);
    expect(resolved.args[0]).toContain("host-hub");
  });
});

describe("HostAttach", () => {
  it("行泵：命令行泵出（含半行拼接）", async () => {
    const lines: string[] = [];
    const attach = new HostAttach({
      exec: fakeExec(),
      env: { ...process.env } as Record<string, string>,
      heartbeatDeadlineMs: 60_000,
      onLine: (line) => lines.push(line),
      onRestart: () => {},
      log: () => {},
    });
    attach.start();
    await vi.waitFor(() => {
      if (!attach.alive()) throw new Error("not alive");
    });
    attach.write(JSON.stringify({ type: "get_state", id: "q1" }));
    const hasEcho = (): boolean => lines.some((l) => l.includes("q1"));
    await vi.waitFor(
      () => {
        if (!hasEcho()) throw new Error("no echo");
      },
      { timeout: 8000 },
    );
    await attach.stop();
  }, 15000);

  it("心跳死线：超时杀+拉起（onRestart 触发）", async () => {
    const restarts: string[] = [];
    const attach = new HostAttach({
      exec: fakeExec(),
      env: { ...process.env, ECHO_HOST_SILENT: "1" } as Record<string, string>,
      heartbeatDeadlineMs: 300,
      onLine: () => {},
      onRestart: (reason) => restarts.push(reason),
      log: () => {},
    });
    attach.start();
    await vi.waitFor(() => {
      if (restarts.length === 0) throw new Error("no restart");
    }, { timeout: 8000 });
    await attach.stop();
  }, 15000);

  it("host stderr 转发到 log（39 行泵）；restart 后计数清零", { timeout: 15000 }, async () => {
    const stderrLines: string[] = [];
    const attach = new HostAttach({
      exec: { command: process.execPath, args: [new URL("./stderr-host.ts", import.meta.url).pathname] },
      env: { ...process.env } as Record<string, string>,
      heartbeatDeadlineMs: 60_000,
      onLine: () => {},
      onRestart: () => {},
      log: (m) => stderrLines.push(m),
    });
    attach.start();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => { setTimeout(r, 100); });
      if (stderrLines.some((l) => l.includes("STDERR-MARKER"))) break;
    }
    expect(stderrLines.some((l) => l.includes("STDERR-MARKER"))).toBe(true);
    await attach.stop();
  });

  it("stop 后 write 返回 false；alive false", async () => {
    const attach = new HostAttach({
      exec: fakeExec(),
      env: { ...process.env } as Record<string, string>,
      heartbeatDeadlineMs: 60_000,
      onLine: () => {},
      onRestart: () => {},
      log: () => {},
    });
    attach.start();
    await vi.waitFor(() => {
      if (!attach.alive()) throw new Error("not alive");
    });
    await attach.stop();
    expect(attach.alive()).toBe(false);
    expect(attach.write("{}")).toBe(false);
  }, 15000);
});
