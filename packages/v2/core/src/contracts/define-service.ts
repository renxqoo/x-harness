import type { Result, ServiceSpec, ServiceToken } from "./types";
import { createDefinition } from "./create-definition";

export function defineService<S>(spec: ServiceSpec<S>): Result<ServiceToken<S>> {
  return createDefinition("service", spec) as Result<ServiceToken<S>>;
}
