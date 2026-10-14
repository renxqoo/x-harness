import type { Result, EventSpec, EventToken } from "./types";
import { createDefinition } from "./create-definition";

export function defineEvent<T>(spec: EventSpec<T>): Result<EventToken<T>> {
  return createDefinition("event", spec) as Result<EventToken<T>>;
}
