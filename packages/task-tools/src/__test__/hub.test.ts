import { describe, expect, it } from "vitest";
import { createTaskHub } from "../hub.ts";
import type { TaskSource } from "../tokens.ts";

const stub = (kind: "agent" | "bash"): TaskSource => ({
  kind,
  probe: () => ({ kind: "miss" }),
  stop: () => {
    throw new Error("unused");
  },
});

describe("task hub registry", () => {
  it("routes in kind dictionary order regardless of registration order (agent before bash)", () => {
    const hub = createTaskHub();
    hub.registerSource(stub("bash"));
    hub.registerSource(stub("agent"));
    expect(hub.sources().map((source) => source.kind)).toEqual(["agent", "bash"]);
  });

  it("throws on duplicate source kind (assembly fail-fast)", () => {
    const hub = createTaskHub();
    hub.registerSource(stub("agent"));
    expect(() => hub.registerSource(stub("agent"))).toThrow(/duplicate task source kind 'agent'/);
  });

  it("unregister removes the source and only the registrar's own", () => {
    const hub = createTaskHub();
    const first = stub("bash");
    const off = hub.registerSource(first);
    off();
    expect(hub.sources()).toEqual([]);
    hub.registerSource(stub("bash"));
    off();
    expect(hub.sources().map((source) => source.kind)).toEqual(["bash"]);
  });
});
