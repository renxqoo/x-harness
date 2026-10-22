import type { LoaderFault, LoaderPhase } from "./types";

export function loaderFault(
  code: LoaderFault["code"],
  context: { readonly phase?: LoaderPhase; readonly entryIndex?: number } = {},
): { readonly ok: false; readonly error: LoaderFault } {
  const phase =
    context.phase &&
    ["sdk", "shared", "watch", "build", "import", "validate", "close"].includes(context.phase)
      ? context.phase
      : undefined;
  const entryIndex =
    Number.isSafeInteger(context.entryIndex) &&
    context.entryIndex! >= 0 &&
    context.entryIndex! < 128
      ? context.entryIndex
      : undefined;
  return {
    ok: false,
    error: Object.freeze({
      source: "loader",
      code,
      message: code,
      ...(phase ? { phase } : {}),
      ...(entryIndex !== undefined ? { entryIndex } : {}),
    }),
  };
}
