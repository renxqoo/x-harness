import assert from "node:assert/strict";
import type { Sample } from "./types";

export function summarizeSamples(samples: readonly Sample[]) {
  assert(samples.length > 0);
  const first = samples[0]!;
  assert(samples.every((sample) => sample.engine === first.engine && sample.scenario === first.scenario && sample.iterations === first.iterations && sample.batch === first.batch && sample.checksum === first.checksum));
  const distribution = (values: readonly number[]) => {
    assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
    return { min: ordered[0]!, median, p95: ordered[Math.ceil(ordered.length * 0.95) - 1]!, max: ordered.at(-1)! };
  };
  return { engine: first.engine, scenario: first.scenario, samples: samples.length,
    meanCallUs: distribution(samples.map((sample) => sample.elapsedMs * 1000 / sample.iterations)),
    batchMeanUs: distribution(samples.flatMap((sample) => [...sample.batchMeanUs])),
  };
}
