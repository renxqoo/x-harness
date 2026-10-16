import type { Context, DefinitionRef, Disposer, Result } from "../contracts/types";
import { createFault } from "../contracts/create-fault";
import { readCapability } from "./read-capability";

export function registerPluginHandler(context: Context, definitions: Readonly<Record<string, DefinitionRef>>, input: {
  kind: "event" | "chain" | "guard"; name: unknown; handler: unknown;
}): Result<Disposer> {
  const token = readCapability(definitions, input.name);
  if (!token.ok) return token;
  if (token.value.kind !== input.kind) return createFault("invalid-definition");
  if (token.value.kind === "chain") return context.middleware(token.value as never, input.handler as never);
  if (token.value.kind === "guard") return context.guard(token.value as never, input.handler as never);
  return context.on(token.value as never, input.handler as never);
}
