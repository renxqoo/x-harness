import type { Provider, Runtime } from "../runtime/types";
import { revokeLease } from "./revoke-lease";

export function revokeProvider(runtime: Runtime, provider: Provider): void {
  provider.active = false;
  for (const lease of provider.leases) revokeLease(runtime, lease);
  provider.implementation = undefined;
  provider.terminal = undefined;
}
