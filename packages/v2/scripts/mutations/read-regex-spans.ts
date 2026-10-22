import { parseSync } from "oxc-parser";
import { collectRegexSpans } from "./collect-regex-spans";

export function readRegexSpans(source: string, fragment: boolean): Map<number, number> {
  const parsed = parseSync("mutation.ts", source, { lang: "ts", sourceType: "module" });

  if (!parsed.errors.length) return collectRegexSpans(parsed.program, 0);

  if (!fragment) throw new Error(`Cannot parse mutation source: ${parsed.errors[0]!.message}`);

  if (!source.includes("/")) return new Map();

  const contexts = [
    ["(", ")"],
    ["function __mutation(){", "}"],
    ["({", "})"],
    ["(true", ")"],
  ] as const;

  for (const [prefix, suffix] of contexts) {
    const wrapped = parseSync("mutation.ts", prefix + source + suffix, {
      lang: "ts",
      sourceType: "module",
    });

    if (!wrapped.errors.length) return collectRegexSpans(wrapped.program, prefix.length);
  }

  throw new Error(`Cannot parse mutation fragment containing slash: ${parsed.errors[0]!.message}`);
}
