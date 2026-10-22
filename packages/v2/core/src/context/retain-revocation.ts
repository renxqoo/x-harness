import { retainers } from "./revocation-data";

export function retainRevocation(capability: object, revoke: () => void): void {
  retainers.get(capability)!(revoke);
}
