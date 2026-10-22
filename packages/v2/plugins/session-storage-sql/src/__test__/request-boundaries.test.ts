import { expect, it } from "vitest";
import { readStorageLimits } from "../read-limits";
it("storage limits reject invalid numeric budgets while preserving fourfold configurations", () => {
  for (const raw of [
    1,
    { extra: 1 },
    { maxQueue: 0 },
    { maxQueue: NaN },
    { transactionTimeoutMs: 40001 },
  ])
    expect(readStorageLimits(raw).ok).toBe(false);

  expect(readStorageLimits({ maxConcurrent: 32 }).ok).toBe(true);
});
