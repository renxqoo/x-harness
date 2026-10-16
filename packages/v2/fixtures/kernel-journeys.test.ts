import { expect, it } from "vitest";
import { readService } from "../scripts/comparison/harness/read-service";
import { closeResource } from "../scripts/comparison/harness/close-resource";
import { joinTask } from "../scripts/comparison/harness/join-task";
import { deliverEvent } from "../scripts/comparison/harness/deliver-event";
import { replaceProvider } from "../scripts/comparison/harness/replace-provider";
import { drainReplacement } from "../scripts/comparison/harness/drain-replacement";

it("public plugins provide and consume a service", async () => { expect(await readService()).toBe("hello:world"); });
it("async resource opens once and closes on shutdown", async () => { expect(await closeResource()).toEqual({ opened: 1, closed: 1 }); });
it("shutdown cancels a task and joins its actual body", async () => { expect(await joinTask()).toEqual({ finished: 1, cancelled: true, closeWaited: true }); });
it("a declared event reaches the listener", async () => { expect(await deliverEvent()).toEqual(["changed"]); });
it("provider replacement restarts consumers and revokes saved entries", async () => { expect(await replaceProvider()).toEqual({ before: "old", after: "new", starts: 2, cleanup: ["consumer", "provider:old"], savedEntry: "revoked" }); });
it("replacement keeps resources open until the in-flight body settles", async () => { expect(await drainReplacement()).toEqual({ closedBeforeGate: false, replacementSettledBeforeGate: false, bodySawClosed: false, savedEntryBlocked: true, next: "new" }); });
