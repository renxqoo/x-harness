import type { Result } from "../../core/src/index";

export type Engine = "cordis" | "harness";
export type Scenario = "plain" | "unused" | "nested" | "selective";
export interface Endpoint { read(input: number): Promise<Result<number>> }
export interface Target { endpoint: Endpoint; close(): Promise<void> }
export interface Sample {
  worker: { bun: string; execArgv: readonly string[]; jit: string | undefined };
  engine: Engine;
  scenario: Scenario;
  iterations: number;
  batch: number;
  checksum: number;
  elapsedMs: number;
  batchMeanUs: readonly number[];
}
