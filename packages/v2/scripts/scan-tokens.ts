import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export function* scanTokens(source: string) {
  const scanner = createScanner(false, LanguageVariant.Standard, source); const templates: number[] = []; let depth = 0; let previousEnd = -1;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
      kind = scanner.reScanTemplateToken(false); if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) depth += 1;
    else if (kind === SyntaxKind.CloseBraceToken) depth -= 1;
    if (kind === SyntaxKind.TemplateHead) templates.push(depth);
    const end = scanner.getTokenEnd(); if (end === previousEnd) throw new Error("Source scanner did not advance"); previousEnd = end;
    yield { kind, text: scanner.getTokenText(), value: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : undefined };
  }
}
