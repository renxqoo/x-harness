import { Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";

export function collectRegexSpans(program: Program, offset: number): Map<number, number> {
  const spans = new Map<number, number>();
  new Visitor({
    Literal(node) {
      if ("regex" in node) spans.set(node.start - offset, node.end - offset);
    },
  }).visit(program);
  return spans;
}
