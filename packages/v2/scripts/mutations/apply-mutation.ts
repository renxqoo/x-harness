import { locateMutation } from "./locate-mutation";
import type { MutationEdit } from "./types";

export function applyMutation(source: string, edit: MutationEdit): string {
  if (!edit.before.trim()) throw new Error("Mutation anchor must not be empty");

  const expected = edit.expectedMatches ?? 1;

  if (!Number.isSafeInteger(expected) || expected < 1)
    throw new Error("Mutation expectedMatches must be a positive integer");

  const spans = locateMutation(source, edit);

  if (spans.length !== expected)
    throw new Error(`Mutation expected ${expected} matches, found ${spans.length}`);

  let result = source;

  for (const span of spans.toReversed())
    result = result.slice(0, span.start) + edit.after + result.slice(span.end);

  return result;
}
