import type { DefinitionRef, Result } from "../contracts/types";
import { createFault } from "../contracts/create-fault";

export function readCapability(
  declarations: Readonly<Record<string, DefinitionRef>>,
  name: unknown,
): Result<DefinitionRef> {
  if (typeof name !== "string" || !Object.hasOwn(declarations, name))
    return createFault("undeclared-dependency");

  return { ok: true, value: declarations[name]! };
}
