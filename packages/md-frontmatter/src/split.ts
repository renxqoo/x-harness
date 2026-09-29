export interface FrontmatterParts {
  readonly head: string;
  readonly body: string;
}

export function splitFrontmatter(text: string): FrontmatterParts | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  return { head: text.slice(4, end), body: text.slice(end + 5) };
}
