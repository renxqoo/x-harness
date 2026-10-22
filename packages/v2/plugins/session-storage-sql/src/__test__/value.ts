import type { Result } from "../../../../core/src/index";

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}
