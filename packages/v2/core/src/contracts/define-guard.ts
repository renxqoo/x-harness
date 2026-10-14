import type { Result, GuardSpec, GuardToken } from "./types";
import { createDefinition } from "./create-definition";

export function defineGuard<I>(spec: GuardSpec<I>): Result<GuardToken<I>> {
  return createDefinition("guard", spec) as Result<GuardToken<I>>;
}
