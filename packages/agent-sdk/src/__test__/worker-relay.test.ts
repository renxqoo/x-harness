import { describe, expect, it } from "vitest";
import { createFrameRelay } from "../executor-worker/relay.ts";
import { helloFrame, eventFrame, hubErrorFrame, workerHeartbeatFrame } from "../frames.ts";

interface RelayProbe {
  events: string[];
  settled: string[];
  beats: number;
  violations: string[];
  rejected: string[];
}

function makeRelay(): { relay: ReturnType<typeof createFrameRelay>; probe: RelayProbe } {
  const probe: RelayProbe = { events: [], settled: [], beats: 0, violations: [], rejected: [] };
  const relay = createFrameRelay({
    emitClient: () => {},
    onHelloRejected: (reason) => {
      probe.rejected.push(reason);
    },
    onHeartbeat: () => {
      probe.beats += 1;
    },
    onResponse: () => {},
    onControlResponse: () => false,
    onSettled: (sendId) => {
      probe.settled.push(sendId);
    },
    onViolation: (reason) => {
      probe.violations.push(reason);
    },
  });
  return { relay, probe };
}

describe("executor-worker relay（host 原版语义）", () => {
  it("hello 握手成功后进入帧循环", () => {
    const { relay, probe } = makeRelay();
    expect(relay.ingest(helloFrame())).toBe(true);
    expect(relay.helloSeen()).toBe(true);
    expect(probe.violations).toEqual([]);
  });

  it("hello 版本不匹配拒绝", () => {
    const { relay, probe } = makeRelay();
    expect(relay.ingest('{"type":"hello","protocolVersion":99,"backendId":"x-harness"}')).toBe(false);
    expect(probe.rejected.length).toBe(1);
    expect(relay.helloSeen()).toBe(false);
  });

  it("首帧非 hello 判违例", () => {
    const { relay, probe } = makeRelay();
    expect(relay.ingest(eventFrame({ threadId: "t", name: "x", payload: {} }))).toBe(false);
    expect(probe.violations).toContain("first frame is not hello");
  });

  it("worker heartbeat 与 settled 事件被解析", () => {
    const { relay, probe } = makeRelay();
    relay.ingest(helloFrame());
    expect(relay.ingest(workerHeartbeatFrame({ idleMs: 5, streaming: true, sessionPath: "/s", rssBytes: 1 }))).toBe(true);
    expect(relay.ingest(eventFrame({ threadId: "t1", name: "settled", payload: { sendId: "q1", ok: true } }))).toBe(true);
    expect(probe.beats).toBe(1);
    expect(probe.settled).toEqual(["q1"]);
  });

  it("垃圾帧不抛异常", () => {
    const { relay } = makeRelay();
    relay.ingest(helloFrame());
    expect(() => relay.ingest("not json")).not.toThrow();
    expect(() => relay.ingest(hubErrorFrame("x"))).not.toThrow();
  });
});
