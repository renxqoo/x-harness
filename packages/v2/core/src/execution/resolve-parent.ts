import type { View, Work } from "../foundation/types";

export function resolveParent(view: View): Work | undefined {
  if (view.bound) return view.bound;
  if (view.cleanup || (view.owner.kind === "host" && view.owner.transaction?.phase === "staging")) return undefined;
  let owner = view.owner;
  for (;;) {
    if (owner.activation && !owner.activation.settled) return owner.activation;
    const creator = owner.scope.creator;
    if (!creator || creator === owner) return undefined;
    owner = creator;
  }
}
