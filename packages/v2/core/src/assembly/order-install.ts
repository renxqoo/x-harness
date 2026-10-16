import type { Result } from "../contracts/types";
import type { Kernel, Owner } from "../foundation/types";

export function orderInstall(owners: readonly Owner[], fault: Kernel["fault"]): Result<Owner[]> {
  const positions = new Map(owners.map((owner, index) => [owner, index]));
  const dependencies = new Map<Owner, number>();
  const consumers = new Map<Owner, Owner[]>();
  const ready: Owner[] = [];
  const insert = (owner: Owner) => {
    let index = ready.push(owner) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (positions.get(ready[parent]!)! <= positions.get(owner)!) break;
      ready[index] = ready[parent]!;
      index = parent;
    }
    ready[index] = owner;
  };
  const take = () => {
    const first = ready[0]!;
    const last = ready.pop()!;
    if (!ready.length) return first;
    let index = 0;
    while (index * 2 + 1 < ready.length) {
      let child = index * 2 + 1;
      if (child + 1 < ready.length && positions.get(ready[child + 1]!)! < positions.get(ready[child]!)!) child += 1;
      if (positions.get(last)! <= positions.get(ready[child]!)!) break;
      ready[index] = ready[child]!;
      index = child;
    }
    ready[index] = last;
    return first;
  };
  for (const owner of owners) {
    const upstream = new Set([...owner.bindings.values()].filter((provider) => provider && positions.has(provider.owner)).map((provider) => provider!.owner));
    dependencies.set(owner, upstream.size);
    if (!upstream.size) insert(owner);
    for (const provider of upstream) {
      const downstream = consumers.get(provider) ?? [];
      downstream.push(owner);
      consumers.set(provider, downstream);
    }
  }
  const ordered: Owner[] = [];
  while (ready.length) {
    const owner = take();
    ordered.push(owner);
    for (const consumer of consumers.get(owner) ?? []) {
      const remaining = dependencies.get(consumer)! - 1;
      dependencies.set(consumer, remaining);
      if (!remaining) insert(consumer);
    }
  }
  return ordered.length === owners.length ? { ok: true, value: ordered } : fault("dependency-cycle");
}
