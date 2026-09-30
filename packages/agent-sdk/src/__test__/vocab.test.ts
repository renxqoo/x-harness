import { describe, expect, it } from "vitest";
import {
  COMMAND_NAMES,
  DRIVING_COMMANDS,
  HOST_RELAYED_THREAD_COMMANDS,
  LIVE_ONLY_COMMANDS,
  OBSERVER_COMMANDS,
  PARKED_DIRECT_COMMANDS,
  THREAD_SCOPED_COMMANDS,
  isInternalId,
  isKnownCommand,
  isLiveOnly,
  isThreadScoped,
} from "../vocab.ts";

describe("sdk command vocabulary contract", () => {
  it("is a closed set of 82 commands", () => {
    expect(COMMAND_NAMES.length).toBe(82);
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it("derived sets are subsets of the closed set", () => {
    for (const name of THREAD_SCOPED_COMMANDS) expect(isKnownCommand(name)).toBe(true);
    for (const name of OBSERVER_COMMANDS) expect(isKnownCommand(name)).toBe(true);
    for (const name of DRIVING_COMMANDS) expect(isKnownCommand(name)).toBe(true);
    for (const name of LIVE_ONLY_COMMANDS) expect(isKnownCommand(name)).toBe(true);
    for (const name of HOST_RELAYED_THREAD_COMMANDS) expect(isKnownCommand(name)).toBe(true);
    for (const name of PARKED_DIRECT_COMMANDS) expect(isKnownCommand(name)).toBe(true);
  });

  it("observer and driving sets are subsets of thread-scoped or relayed sets", () => {
    for (const name of OBSERVER_COMMANDS) {
      expect(isThreadScoped(name) || HOST_RELAYED_THREAD_COMMANDS.has(name)).toBe(true);
    }
    for (const name of DRIVING_COMMANDS) expect(isThreadScoped(name)).toBe(true);
    for (const name of LIVE_ONLY_COMMANDS) expect(isLiveOnly(name)).toBe(true);
  });

  it("unknown commands are rejected", () => {
    expect(isKnownCommand("nope")).toBe(false);
    expect(isThreadScoped("nope")).toBe(false);
    expect(isLiveOnly("nope")).toBe(false);
  });

  it("internal ids use the reserved prefix", () => {
    expect(isInternalId("@hub-internal:1")).toBe(true);
    expect(isInternalId("abc")).toBe(false);
  });
});
