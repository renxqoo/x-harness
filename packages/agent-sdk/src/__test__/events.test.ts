import { describe, expect, it } from "vitest";
import { SDK_EVENT_KINDS } from "../events.ts";

describe("sdk event vocabulary contract", () => {
  it("is a closed set of 12 kinds", () => {
    expect(SDK_EVENT_KINDS.length).toBe(12);
    expect(new Set(SDK_EVENT_KINDS).size).toBe(SDK_EVENT_KINDS.length);
  });

  it("covers terminal and platform channels", () => {
    expect(SDK_EVENT_KINDS).toContain("settled");
    expect(SDK_EVENT_KINDS).toContain("platform");
    expect(SDK_EVENT_KINDS).toContain("thread_rekeyed");
    expect(SDK_EVENT_KINDS).toContain("git_changed");
    expect(SDK_EVENT_KINDS).toContain("ui_request");
    expect(SDK_EVENT_KINDS).toContain("thread_state");
  });
});
