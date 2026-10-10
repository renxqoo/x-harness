import { describe, expect, it, vi } from "vitest";
import { HostAttach } from "../host-attach.ts";

const BIG_LINE_PAD_BYTES = 4 * 1024 * 1024;
const BIG_LINE_MARKER = "BIGLINE-MARKER";

/** 永不读 stdin 的 host（进程活着但卡住）——写入进得了管道，出不来 */
const DEAF_HOST = "setTimeout(() => {}, 120000)";

function attachCapturing(lines: string[]): HostAttach {
  const self = new URL("./echo-host.ts", import.meta.url).pathname;
  const attach = new HostAttach({
    exec: { command: process.execPath, args: [self] },
    env: { ...process.env } as Record<string, string>,
    heartbeatDeadlineMs: 600_000,
    onLine: (line) => lines.push(line),
    onRestart: () => {},
    log: () => {},
  });
  attach.start();
  return attach;
}

function deafHost(): HostAttach {
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

async function waitAlive(attach: HostAttach): Promise<void> {
  await vi.waitFor(() => {
    if (!attach.alive()) throw new Error("host not alive");
  });
}

async function echoedIds(lines: readonly string[]): Promise<Array<string | undefined>> {
  await vi.waitFor(() => {
    if (!lines.some((l) => l.includes(BIG_LINE_MARKER))) throw new Error("host has not echoed the big line");
  }, { timeout: 20_000 });
  return lines.filter((l) => l.includes(BIG_LINE_MARKER)).map((l) => (JSON.parse(l) as { id?: string }).id);
}

describe("症状「发一条带图消息，手机上出现两条一模一样的气泡」", () => {
  it("host 读 stdin 时：大命令行投递成功且被逐字收到", async () => {
    const lines: string[] = [];
    const attach = attachCapturing(lines);
    await waitAlive(attach);

    const line = JSON.stringify({ type: "get_state", id: BIG_LINE_MARKER, pad: "A".repeat(BIG_LINE_PAD_BYTES) });
    const outcome = attach.deliver(line);

    expect(outcome).toEqual({ delivered: true });
    expect(await echoedIds(lines)).toEqual([BIG_LINE_MARKER]);
    await attach.stop();
  }, 40_000);

  it("host 卡死不读 stdin 时：投递仍算成功（背压不是失败），且不挂死", async () => {
    const attach = deafHost();
    await waitAlive(attach);

    const began = Date.now();
    const outcome = attach.deliver("A".repeat(2 * 1024 * 1024));

    expect(outcome).toEqual({ delivered: true });
    expect(Date.now() - began).toBeLessThan(1_000);
    attach.killChildForTest();
  }, 20_000);

  it("host 已死时：投递判失败（真没送达，不是假失败）", async () => {
    const attach = deafHost();
    await waitAlive(attach);
    await attach.stop();

    expect(attach.alive()).toBe(false);
    expect(attach.deliver("{}")).toEqual({ delivered: false });
  }, 20_000);

  it("stop() 后投递判失败（不留悬挂的在途投递）", async () => {
    const lines: string[] = [];
    const attach = attachCapturing(lines);
    await waitAlive(attach);
    await attach.stop();

    expect(attach.deliver(JSON.stringify({ type: "get_state", id: "AFTER-STOP" }))).toEqual({ delivered: false });
  }, 20_000);
});