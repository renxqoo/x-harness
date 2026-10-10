import { describe, expect, it } from "vitest";
import { HostAttach } from "../host-attach.ts";

/** 不读 stdin、也不响应 end 的 host——停不掉自己 */
const DEAF_HOST = "process.stdin.resume(); setTimeout(()=>{},120000);";

function attachDeaf(): HostAttach {
  const attach = new HostAttach({
    exec: { command: process.execPath, args: ["-e", DEAF_HOST] },
    env: { ...process.env } as Record<string, string>,
    heartbeatDeadlineMs: 600_000,
    onLine: () => {},
    onRestart: () => {},
    log: () => {},
  });
  attach.start();
  return attach;
}

function aliveOf(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("症状「网关退出后 host 子进程还活着，资源泄漏」", () => {
  it("stop() 对不读 stdin 的 host 必须真杀掉，不靠对端配合退出", async () => {
    const attach = attachDeaf();
    await delay(500);
    const pid = attach.childPid();
    expect(aliveOf(pid)).toBe(true);

    await attach.stop();

    expect(aliveOf(pid)).toBe(false);
  }, 30_000);

  it("stop() 不得复活在途 restart() 已经拉起的新 child", async () => {
    const attach = attachDeaf();
    await delay(500);
    void attach.restart("probe");
    await delay(40);
    await attach.stop();
    await delay(700);

    const afterStop = attach.childPid();
    expect(aliveOf(afterStop)).toBe(false);
    expect(afterStop).toBeUndefined();
  }, 30_000);
});