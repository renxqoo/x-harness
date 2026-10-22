import type { DefinitionRef, DependencyContext, Result, ServiceToken } from "../contracts/types";
import type { DependencyLayout } from "./describe-dependencies";
import { createFault } from "../contracts/create-fault";
import { retainRevocation } from "./retain-revocation";

type Service = Record<string, (input: unknown) => Promise<Result<unknown, unknown>>>;
interface DependencySource {
  context: DependencyContext;
  required: Readonly<Record<string, DefinitionRef>>;
  optional: Readonly<Record<string, DefinitionRef>>;
}
interface DependencyCell {
  current?: DependencySource;
}
const empty: Readonly<Record<string, unknown>> = Object.freeze(
  Object.create(null) as Record<string, unknown>,
);

export function createDependencies(
  layout: DependencyLayout,
  source?: DependencySource,
): Readonly<Record<string, unknown>> {
  if (!layout.length) return empty;

  const cell: DependencyCell = { current: source };

  if (source) retainRevocation(source.context, revoke(cell));

  const dependencies: Record<string, unknown> = Object.create(null);

  for (const { name, methods } of layout) {
    if (!methods) {
      dependencies[name] = undefined;
      continue;
    }

    if (layout.length === 1) {
      dependencies[name] = dependencyFacade(cell, name, methods);
      continue;
    }

    Object.defineProperty(dependencies, name, {
      enumerable: true,
      get: dependencyGetter(cell, name, methods),
    });
  }

  return Object.freeze(dependencies);
}

function revoke(cell: DependencyCell): () => void {
  return () => {
    cell.current = undefined;
  };
}

function dependencyGetter(
  cell: DependencyCell,
  name: string,
  methods: readonly string[],
): () => Service {
  let service: Service | undefined;
  return () => (service ??= dependencyFacade(cell, name, methods));
}

function dependencyFacade(cell: DependencyCell, name: string, methods: readonly string[]): Service {
  const service: Service = Object.create(null);
  let acquired: Service | undefined;

  for (const method of methods)
    service[method] = (input: unknown) => {
      const current = cell.current;

      if (!current)
        return Promise.resolve(createFault(acquired ? "service-unavailable" : "cancelled"));

      if (!acquired) {
        const token = current.required[name] ?? current.optional[name];
        const resolved = current.context.use(token as ServiceToken<Service>);

        if (!resolved.ok) return Promise.resolve(resolved);

        acquired = resolved.value;
      }

      return acquired[method]!(input);
    };

  return Object.freeze(service);
}
