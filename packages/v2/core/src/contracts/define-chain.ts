import type { Result, ChainSpec, ChainToken } from "./types";
import { createDefinition } from "./create-definition";

export function defineChain<I, O, E = never>(spec: ChainSpec<I, O>): Result<ChainToken<I, O, E>> {
  return createDefinition("chain", spec) as Result<ChainToken<I, O, E>>;
}
