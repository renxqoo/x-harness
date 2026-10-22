import { expect, it } from "vitest";
import { createStorageQueue } from "../create-storage-queue";
import type { Result } from "../../../../../core/src/index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

it("cancelled queued operations cannot acquire a released transaction slot", async () => {
  const gate = createStorageQueue(1, 1);
  const first = value(await gate.enter());
  const controller = new AbortController();
  const waiting = gate.enter(controller.signal);
  expect(await gate.enter()).toMatchObject({ ok: false, error: { code: "busy" } });
  controller.abort();
  expect(await waiting).toMatchObject({ ok: false, error: { code: "cancelled" } });
  first();
  first();
  const second = value(await gate.enter());
  second();
  await gate.close();
  expect(await gate.enter()).toMatchObject({ ok: false, error: { code: "closed" } });
});
it("close cancels queued work and waits for the active operation to actually finish", async () => {
  const gate = createStorageQueue(1, 2);
  const first = value(await gate.enter());
  const waiting = gate.enter();
  let closed = false;
  const closing = gate.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(await waiting).toMatchObject({ ok: false, error: { code: "cancelled" } });
  first();
  await closing;
  expect(closed).toBe(true);
});
it("released capacity starts the next operation and already aborted requests never queue", async () => {
  const gate = createStorageQueue(1, 2);
  const controller = new AbortController();
  controller.abort();
  expect(await gate.enter(controller.signal)).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  });
  const first = value(await gate.enter());
  const pending = gate.enter();
  first();
  value(await pending)();
  await gate.close();
});
