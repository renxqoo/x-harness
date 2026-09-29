export function buildInitialMessage(parts: { readonly stdin?: string; readonly fileText?: string; readonly firstMessage?: string }): string | undefined {
  const joined = `${parts.stdin ?? ""}${parts.fileText ?? ""}${parts.firstMessage ?? ""}`;
  return joined.length > 0 ? joined : undefined;
}
