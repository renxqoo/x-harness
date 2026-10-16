import type { Owner, Kernel } from "../foundation/types";
import { stopLifetimes } from "./stop-lifetimes";

export function stopOwner(kernel: Kernel, owner: Owner): void {
  stopLifetimes(kernel, { owners: [owner], scopes: [] });
}
