import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import type { MutationToken } from "./types";
import { readRegexSpans } from "./read-regex-spans";

export function scanMutationTokens(source: string, fragment = false): MutationToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const regexSpans = readRegexSpans(source, fragment);
  let scannedRegexes = 0;
  const templates: number[] = [];
  const tokens: MutationToken[] = [];
  let depth = 0;
  let previousEnd = -1;

  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const regexEnd = regexSpans.get(scanner.getTokenStart());

    if (regexEnd !== undefined) {
      if (kind !== SyntaxKind.SlashToken && kind !== SyntaxKind.SlashEqualsToken)
        throw new Error("Regular expression span does not start at a slash");

      kind = scanner.reScanSlashToken();

      if (kind !== SyntaxKind.RegularExpressionLiteral || scanner.getTokenEnd() !== regexEnd)
        throw new Error("Regular expression parser and scanner spans disagree");

      scannedRegexes += 1;
    }

    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
      kind = scanner.reScanTemplateToken(false);

      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) depth += 1;
    else if (kind === SyntaxKind.CloseBraceToken) depth -= 1;

    if (kind === SyntaxKind.TemplateHead) templates.push(depth);

    const end = scanner.getTokenEnd();

    if (end <= previousEnd) throw new Error("Mutation scanner did not advance");

    previousEnd = end;
    tokens.push({
      kind,
      text: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText(),
      start: scanner.getTokenStart(),
      end,
    });
  }

  if (scannedRegexes !== regexSpans.size)
    throw new Error("Regular expression span was not scanned");

  const normalized: MutationToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];

    if (
      token.kind === SyntaxKind.CommaToken &&
      tokens[index - 1]?.kind !== SyntaxKind.CommaToken &&
      tokens[index - 1]?.kind !== SyntaxKind.OpenBracketToken &&
      next &&
      [
        SyntaxKind.CloseParenToken,
        SyntaxKind.CloseBracketToken,
        SyntaxKind.CloseBraceToken,
      ].includes(next.kind)
    )
      continue;

    if (
      token.kind === SyntaxKind.OpenParenToken &&
      next?.kind === SyntaxKind.Identifier &&
      tokens[index + 2]?.kind === SyntaxKind.CloseParenToken &&
      tokens[index + 3]?.kind === SyntaxKind.EqualsGreaterThanToken
    ) {
      normalized.push({ ...next, start: token.start, end: tokens[index + 2]!.end });
      index += 2;
    } else normalized.push(token);
  }

  return normalized;
}
