import { scanMutationTokens } from "./scan-mutation-tokens";
import type { MutationEdit, MutationSpan } from "./types";

export function locateMutation(source: string, edit: MutationEdit): MutationSpan[] {
  const spans: MutationSpan[] = [];

  if (edit.mode === "raw") {
    for (
      let start = source.indexOf(edit.before);
      start !== -1;
      start = source.indexOf(edit.before, start + edit.before.length)
    ) {
      spans.push({ start, end: start + edit.before.length });
    }

    return spans;
  }

  const pattern = scanMutationTokens(edit.before, true);

  if (!pattern.length) throw new Error("Mutation anchor must contain tokens");

  const tokens = scanMutationTokens(source);

  for (let start = 0; start <= tokens.length - pattern.length; start += 1) {
    if (
      !pattern.every(
        (token, offset) =>
          token.kind === tokens[start + offset]!.kind &&
          token.text === tokens[start + offset]!.text,
      )
    )
      continue;

    spans.push({ start: tokens[start]!.start, end: tokens[start + pattern.length - 1]!.end });
    start += pattern.length - 1;
  }

  return spans;
}
