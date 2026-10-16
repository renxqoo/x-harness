import type { Disposer, Result } from "../../contracts/types";
import type { Kernel } from "../../foundation/types";
import type { Provision } from "../services/prepare-provision";
import { definitionData } from "../../contracts/definition-data";
import { provideDefinition } from "../services/provide-definition";

export function handleChain(kernel: Kernel, args: Provision): Result<Disposer> {
  if (definitionData.get(args.token)?.token.kind !== "chain") return kernel.fault("invalid-definition", args.view.owner);
  return provideDefinition(kernel, args);
}
