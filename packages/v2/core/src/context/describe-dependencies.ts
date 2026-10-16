import { definitionData } from "../contracts/definition-data";
import type { Owner } from "../foundation/types";

export type DependencyLayout = readonly Readonly<{ name: string; methods?: readonly string[] }>[];
const layouts = new WeakMap<Owner, WeakMap<Owner["bindings"], DependencyLayout>>();
const empty: DependencyLayout = Object.freeze([]);

export function describeDependencies(owner: Owner, bindings: Owner["bindings"]): DependencyLayout {
  let entries = layouts.get(owner);
  const cached = entries?.get(bindings);
  if (cached) return cached;
  const layout = Object.entries({ ...owner.plugin?.requires, ...owner.plugin?.optional }).flatMap(([name, token]) => {
    if (token.kind !== "service") return [];
    return [Object.freeze({ name, methods: bindings.get(token) === null ? undefined : Object.freeze(Object.keys(definitionData.get(token)!.methods)) })];
  });
  if (!entries) { entries = new WeakMap(); layouts.set(owner, entries); }
  const frozen = layout.length ? Object.freeze(layout) : empty;
  entries.set(bindings, frozen); return frozen;
}
