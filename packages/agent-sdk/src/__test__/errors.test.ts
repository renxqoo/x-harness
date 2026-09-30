import { describe, expect, it } from "vitest";
import { SDK_ERROR_CODES } from "../errors.ts";

describe("sdk error codes contract", () => {
  it("is a closed set of 26 codes matching hub vocabulary", () => {
    expect(SDK_ERROR_CODES.length).toBe(26);
    expect(SDK_ERROR_CODES).toContain("unknown_thread");
    expect(SDK_ERROR_CODES).toContain("session_unreadable");
    expect(SDK_ERROR_CODES).toContain("thread_superseded");
    expect(SDK_ERROR_CODES).toContain("state_conflict");
    expect(SDK_ERROR_CODES).toContain("plugin_install_failed");
  });

  it("has no duplicates", () => {
    expect(new Set(SDK_ERROR_CODES).size).toBe(SDK_ERROR_CODES.length);
  });
});
