export function shellQuoteWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function commandOf(argv: readonly string[]): string {
  if (argv.length === 0) return "";
  return `exec ${argv.map(shellQuoteWord).join(" ")}`;
}
