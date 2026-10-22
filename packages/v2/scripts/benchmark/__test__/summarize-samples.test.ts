import { describe, expect, it } from "vitest";
import { summarizeSamples } from "../summarize-samples";
import type { Sample } from "../types";

const sample = (elapsedMs: number): Sample => ({
  worker: { bun: "test", execArgv: [], jit: "true" },
  engine: "harness",
  scenario: "plain",
  iterations: 100,
  batch: 100,
  checksum: 5050,
  elapsedMs,
  batchMeanUs: [elapsedMs * 10],
});

describe("benchmark result integrity", () => {
  it("uses every sample and keeps batch means separate from per-round means", () => {
    const input = [sample(4), sample(1), sample(3), sample(2)];
    const summary = summarizeSamples(input);
    expect(summary.meanCallUs).toEqual({ min: 10, median: 25, p95: 40, max: 40 });
    expect(summary.samples).toBe(4);
    expect(input.map((entry) => entry.elapsedMs)).toEqual([4, 1, 3, 2]);
    expect(summarizeSamples(input.slice(0, 3)).meanCallUs.median).toBe(30);
  });
  it("rejects mixed workloads, invalid measurements and mismatched result checksums", () => {
    for (const input of [
      [],
      [sample(NaN)],
      [sample(-1)],
      [sample(1), { ...sample(1), checksum: 0 }],
      [sample(1), { ...sample(1), scenario: "nested" as const }],
    ])
      expect(() => summarizeSamples(input)).toThrow();
  });
});
