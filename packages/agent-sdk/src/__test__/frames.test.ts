import { describe, expect, it } from "vitest";
import {
  classifyResponseHead,
  clientHeartbeatFrame,
  eventFrame,
  helloFrame,
  hubErrorFrame,
  responseLine,
  settledHeadOf,
  threadDiedFrame,
  threadParkedFrame,
  uiRequestFrame,
  workerHeartbeatFrame,
} from "../frames.ts";

describe("frame byte-level snapshots", () => {
  it("responseLine: id present, success with data", () => {
    expect(responseLine({ id: "q1", command: "get_state", success: true, data: { a: 1 } }))
      .toBe('{"id":"q1","type":"response","command":"get_state","success":true,"data":{"a":1}}');
  });

  it("responseLine: id absent emits null, failure with error", () => {
    expect(responseLine({ command: "parse", success: false, error: { code: "protocol", message: "parse failure" } }))
      .toBe('{"id":null,"type":"response","command":"parse","success":false,"error":{"code":"protocol","message":"parse failure"}}');
  });

  it("responseLine: success without data closes immediately", () => {
    expect(responseLine({ id: "q2", command: "thread/stop", success: true }))
      .toBe('{"id":"q2","type":"response","command":"thread/stop","success":true}');
  });

  it("classifyResponseHead round-trips responseLine shapes", () => {
    const withId = responseLine({ id: "abc", command: "prompt", success: true, data: 1 });
    const parsed = classifyResponseHead(withId);
    expect(parsed).toEqual({ kind: "response", id: "abc", command: "prompt", success: true });

    const noId = responseLine({ command: "parse", success: false, error: { code: "protocol", message: "x" } });
    const parsedNoId = classifyResponseHead(noId);
    expect(parsedNoId?.id).toBeUndefined();
    expect(parsedNoId?.success).toBe(false);

    expect(classifyResponseHead('{"type":"event"}')).toBeUndefined();
  });

  it("eventFrame: agentName is appended after payload", () => {
    expect(eventFrame({ threadId: "t1", name: "agent/status", payload: { status: "idle" } }))
      .toBe('{"type":"event","threadId":"t1","name":"agent/status","payload":{"status":"idle"}}');
    expect(eventFrame({ threadId: "t1", name: "agent/spawned", payload: {}, agentName: "coder" }))
      .toBe('{"type":"event","threadId":"t1","name":"agent/spawned","payload":{},"agentName":"coder"}');
  });

  it("settledHeadOf extracts threadId and sendId prefixes", () => {
    const line = eventFrame({ threadId: "t9", name: "settled", payload: { sendId: "q7", ok: true } });
    expect(settledHeadOf(line)).toEqual({ threadId: "t9", sendId: "q7" });
    const internal = eventFrame({ threadId: "t9", name: "settled", payload: { sendId: "", ok: true } });
    expect(settledHeadOf(internal)).toEqual({ threadId: "t9", sendId: "" });
    expect(settledHeadOf('{"type":"event","threadId":"t9","name":"other"}')).toBeUndefined();
  });

  it("uiRequestFrame flattens payload keys to top level and filters reserved keys", () => {
    expect(uiRequestFrame({ requestId: "r1", threadId: "t1", method: "confirm", payload: { command: "rm -rf", mode: "auto", type: "x", requestId: "spoof", threadId: "spoof", method: "spoof" } }))
      .toBe('{"type":"ui_request","requestId":"r1","threadId":"t1","method":"confirm","command":"rm -rf","mode":"auto"}');
    expect(uiRequestFrame({ requestId: "r2", threadId: "t2", method: "ask", payload: {} }))
      .toBe('{"type":"ui_request","requestId":"r2","threadId":"t2","method":"ask"}');
  });

  it("client heartbeat keeps hub-level shape", () => {
    expect(clientHeartbeatFrame({ rssBytes: 123, cpuPercent: 4.2 }))
      .toBe('{"type":"heartbeat","rssBytes":123,"cpuPercent":4.2}');
    expect(clientHeartbeatFrame({ cpuPercent: 0 }))
      .toBe('{"type":"heartbeat","rssBytes":null,"cpuPercent":0}');
  });

  it("worker heartbeat keeps worker-level shape with ordered keys", () => {
    expect(workerHeartbeatFrame({ idleMs: 5, streaming: true, sessionPath: "/s/x/events.jsonl", rssBytes: 9 }))
      .toBe('{"type":"heartbeat","idleMs":5,"streaming":true,"sessionPath":"/s/x/events.jsonl","rssBytes":9}');
    expect(workerHeartbeatFrame({ idleMs: 0, streaming: false, sessionPath: null, rssBytes: null }))
      .toBe('{"type":"heartbeat","idleMs":0,"streaming":false,"sessionPath":null,"rssBytes":null}');
  });

  it("lifecycle frames keep exact bytes", () => {
    expect(hubErrorFrame("boom", "t1")).toBe('{"type":"hub_error","message":"boom","threadId":"t1"}');
    expect(hubErrorFrame("boom")).toBe('{"type":"hub_error","message":"boom"}');
    expect(threadDiedFrame("t1", "worker exited")).toBe('{"type":"thread_died","threadId":"t1","reason":"worker exited"}');
    expect(threadParkedFrame("t1", "idle")).toBe('{"type":"thread_parked","threadId":"t1","reason":"idle"}');
    expect(helloFrame()).toBe('{"type":"hello","protocolVersion":1,"backendId":"x-harness"}');
  });
});
