import { retainers } from "./revocation-data";

export function rememberRevocation(
  capability: object,
  cell: { current?: unknown; releases: Set<() => void> },
): void {
  retainers.set(capability, (revoke) => {
    if (cell.current) cell.releases.add(revoke);
    else revoke();
  });
}
