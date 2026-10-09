import { describe, expect, it } from "vitest";
import { uiRequestFrame } from "../../../host-hub/src/protocol/frames.ts";
import { createHostIngest } from "../host-ingest.ts";
import { Fanout } from "../fanout.ts";
import type { Frame } from "@x-harness/remote-protocol";

function uiRequestToDevice(payload: Record<string, unknown>): Frame | undefined {
  const frames: Frame[] = [];
  const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
  fanout.attach({ target: "d1", tier: "interact", subscribedThreads: new Set(), send: (frame) => void frames.push(frame) });
  createHostIngest({
    fanout,
    devices: { appendResponse: async () => {} } as never,
    threads: { upsert: () => {} } as never,
    audit: { record: async () => {} } as never,
    pendingByHostId: new Map(),
    sendToDevice: () => {},
    replyOwner: () => {},
  }).ingest(uiRequestFrame({ requestId: "req-1", threadId: "t1", method: "confirm", payload }));
  return frames[0];
}

describe("症状「手机上点授权只看到『确认操作』，不知道在批什么」", () => {
  it("host 平铺的载荷经网关收拢回 L2 payload 子对象", () => {
    const frame = uiRequestToDevice({ tool: "write", summary: "Write(permission-probe.txt)", reason: "edit-confirm: in-root write", options: ["once"] });
    expect(frame?.kind).toBe("ui_request");
    const body = frame?.body as { requestId: string; threadId: string; method: string; payload: Record<string, unknown> };
    expect(body.requestId).toBe("req-1");
    expect(body.threadId).toBe("t1");
    expect(body.method).toBe("confirm");
    expect(body.payload).toEqual({ tool: "write", summary: "Write(permission-probe.txt)", reason: "edit-confirm: in-root write", options: ["once"] });
  });

  it("信封键不进载荷（否则 requestId/method 会被当业务字段下发给设备）", () => {
    const body = uiRequestToDevice({ tool: "bash", requestId: "spoofed", type: "spoofed", threadId: "spoofed", method: "spoofed", reason: "r" })?.body as { payload: Record<string, unknown> };
    expect(body.payload).toEqual({ tool: "bash", reason: "r" });
  });

  it("read 档设备收不到权限询问（面按档位隔离）", () => {
    const frames: Frame[] = [];
    const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
    fanout.attach({ target: "d0", tier: "read", subscribedThreads: new Set(), send: (frame) => void frames.push(frame) });
    createHostIngest({
      fanout,
      devices: { appendResponse: async () => {} } as never,
      threads: { upsert: () => {} } as never,
      audit: { record: async () => {} } as never,
      pendingByHostId: new Map(),
      sendToDevice: () => {},
      replyOwner: () => {},
    }).ingest(uiRequestFrame({ requestId: "req-2", threadId: "t1", method: "confirm", payload: { tool: "write", reason: "r" } }));
    expect(frames).toHaveLength(0);
  });
});
