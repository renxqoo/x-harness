import type { Limits } from "../contracts/types";

export function inheritLimits(first: Limits, ...sources: readonly Limits[]): Limits {
  if (sources.every(source => source === first)) return first;
  const inherited = { ...first };
  for (const key of Object.keys(first) as (keyof Limits)[]) {
    for (const source of sources) inherited[key] = Math.min(inherited[key], source[key]);
  }
  return Object.freeze(inherited);
}
