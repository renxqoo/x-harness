import { expect, it } from "vitest";
import { createOwner } from "../create-owner";
import { readLimits } from "../../foundation/read-limits";
import type { Scope, Owner } from "../../foundation/types";

it("closed owner views detach state readers and cannot resurrect registry or execution entries", () => {
  const limits = readLimits(undefined);

  if (!limits.ok) throw new Error("Invalid limits");

  const scope: Scope = {
    id: "root",
    label: "root",
    state: "open",
    controller: new AbortController(),
    limits: limits.value,
    owners: new Set(),
    children: new Set(),
    providers: new Map(),
    tombstones: new WeakSet(),
  };
  const bindings: Owner["bindings"] = new Map();
  let reads = 0;
  let revoked = 0;
  const created = createOwner(
    {
      scope,
      id: "owner",
      plugin: { name: "example", setup: () => ({ ok: true, value: undefined }) },
    },
    {
      bindings() {
        reads += 1;
        return bindings;
      },
      providers() {
        reads += 1;
        return new Set();
      },
      registrations() {
        reads += 1;
        return new Set();
      },
      leases() {
        reads += 1;
        return new Set();
      },
      activities() {
        reads += 1;
        return new Set();
      },
    },
  );
  const { owner, control } = created;
  expect(owner.bindings).toBe(bindings);
  expect(owner.state).toBe("staging");
  control.retainContext(() => {
    revoked += 1;
  });
  control.activate();
  expect(owner.state).toBe("active");
  expect(control.stop(50)).toBe(true);
  expect(control.stop(100)).toBe(false);
  expect(owner.controller.signal.aborted).toBe(true);
  control.limitCleanup(30);
  expect(owner.cleanupDeadline).toBe(30);
  control.finishClose();
  expect(owner.state).toBe("stopped");
  expect(owner.plugin).toBeUndefined();
  expect(owner.bindings).not.toBe(bindings);
  expect([
    owner.bindings.size,
    owner.providers.size,
    owner.registrations.size,
    owner.leases.size,
    owner.activities.size,
  ]).toEqual([0, 0, 0, 0, 0]);
  expect(reads).toBe(1);
  expect(revoked).toBe(1);
  expect(Object.isFrozen(owner)).toBe(true);
});
