import { describe, expect, it } from "vitest";
import { HOST_COMMAND_MATRIX } from "@x-harness/remote-protocol";
import { COMMAND_NAMES } from "../../../host-hub/src/protocol/commands.ts";
import { createHostIngest } from "../host-ingest.ts";
import { Fanout } from "../fanout.ts";

interface Captured {
  device: Array<{ deviceId: string; frame: unknown }>;
  owner: unknown[];
  appended: unknown[];
}

function ingestOnce(body: string, owner: boolean): Captured {
  const captured: Captured = { device: [], owner: [], appended: [] };
  const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
  fanout.attach({ target: "owner", tier: "owner", subscribedThreads: new Set(), send: () => {} });
  const deps = {
    fanout,
    devices: { appendResponse: async (_deviceId: string, _commandId: string, response: unknown) => void captured.appended.push(response) } as never,
    threads: { upsert: () => {} } as never,
    audit: { record: async () => {} } as never,
    pendingByHostId: new Map([["g1", { deviceId: owner ? "owner" : "d1", commandId: "c1", command: "session/prompt" }]]),
    sendToDevice: (deviceId: string, frame: unknown) => void captured.device.push({ deviceId, frame }),
    replyOwner: (_pending: unknown, body: unknown) => void captured.owner.push(body),
  };
  createHostIngest(deps).ingest(body);
  return captured;
}

function onWire(frame: unknown): Record<string, unknown> {
  return (JSON.parse(JSON.stringify(frame)) as { body: Record<string, unknown> }).body;
}

describe("症状「host 失败原因到不了 owner/device 面，只剩未知错误」", () => {
  it("设备侧：host 的 {code,message} 随 response 帧上行，不再被丢成空", () => {
    const captured = ingestOnce('{"id":"g1","type":"response","command":"session/prompt","success":false,"error":{"code":"thread_not_live","message":"thread parked by idle retire"}}', false);
    expect(captured.device.length).toBe(1);
    const frame = captured.device[0]!.frame as { kind: string; body: { success: boolean; error?: { code?: string; message?: string } } };
    expect(frame.kind).toBe("response");
    expect(frame.body.success).toBe(false);
    expect(frame.body.error).toEqual({ code: "thread_not_live", message: "thread parked by idle retire" });
    expect(captured.appended[0]).toMatchObject({ success: false, error: { code: "thread_not_live" } });
  });

  it("owner 面：同一份 {code,message} 原样回投 owner 会话", () => {
    const captured = ingestOnce('{"id":"g1","type":"response","command":"session/prompt","success":false,"error":{"code":"model_unavailable","message":"no such model: x"}}', true);
    expect(captured.device.length).toBe(0);
    expect(captured.owner[0]).toMatchObject({ id: "c1", command: "session/prompt", success: false, error: { code: "model_unavailable", message: "no such model: x" } });
  });

  it("成功响应不带 error 键；host 省略 message 时只带 code", () => {
    const ok = ingestOnce('{"id":"g1","type":"response","command":"session/prompt","success":true,"data":{"ok":true}}', false);
    expect(onWire(ok.device[0]!.frame)).not.toHaveProperty("error");
    const bare = ingestOnce('{"id":"g1","type":"response","command":"session/prompt","success":false,"error":{"code":"internal"}}', false);
    expect((onWire(bare.device[0]!.frame) as { error?: unknown }).error).toEqual({ code: "internal" });
  });

  it("host 吐出非形状 error（字符串/数组/null）时降级为无 error，不把垃圾透传给设备", () => {
    for (const raw of ['"boom"', "[]", "null", "42"]) {
      const captured = ingestOnce(`{"id":"g1","type":"response","command":"session/prompt","success":false,"error":${raw}}`, false);
      expect(onWire(captured.device[0]!.frame)).not.toHaveProperty("error");
    }
  });
});

describe("host 命令面完备性（症状「host 有的命令设备发出去被判 unknown-command」）", () => {
  it("host COMMAND_NAMES 每一项都在网关矩阵里有行，无矩阵多余项", () => {
    const uncovered = COMMAND_NAMES.filter((c) => !(c in HOST_COMMAND_MATRIX));
    const extra = Object.keys(HOST_COMMAND_MATRIX).filter((c) => !COMMAND_NAMES.includes(c));
    expect(uncovered).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("每个 host 命令都有档位：非 owner-only 必须 full 可达（否则设备面命令无路由）", () => {
    const unroutable = COMMAND_NAMES.filter((c) => !HOST_COMMAND_MATRIX[c]!.ownerOnly && !HOST_COMMAND_MATRIX[c]!.full);
    expect(unroutable).toEqual([]);
  });
});