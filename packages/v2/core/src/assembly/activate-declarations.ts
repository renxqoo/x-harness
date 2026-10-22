import type { Context, DefinitionRef, EventToken, GuardToken, Result } from "../contracts/types";

export function activateDeclarations(
  context: Context,
  declarations: Readonly<Record<string, DefinitionRef>>,
): Result<void> {
  for (const token of Object.values(declarations)) {
    if (token.kind !== "guard" && token.kind !== "event") continue;

    const registered = context.register(token as EventToken<unknown> | GuardToken<unknown>);

    if (!registered.ok) return registered;
  }

  return { ok: true, value: undefined };
}
