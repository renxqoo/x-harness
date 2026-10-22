import { expect, it } from "vitest";
import { applyMutation } from "../apply-mutation";

it("regular expression bodies cannot masquerade as code mutation anchors", () => {
  for (const before of ["call.run()", 'read.file("a b")', "foo=>"]) {
    const source = `const pattern = /${before}/;`;
    expect(() => applyMutation(source, { before, after: "false" })).toThrow("found 0");
  }
});

it("whole regular expression anchors preserve escaped delimiters and flag meaning", () => {
  const source = String.raw`const label = "中文😀"; const pattern = /a\/b[{}]/gi;`;
  expect(
    applyMutation(source, {
      before: String.raw`/a\/b[{}]/gi`,
      after: "/replacement/u",
    }),
  ).toBe('const label = "中文😀"; const pattern = /replacement/u;');
  expect(() =>
    applyMutation(source, {
      before: String.raw`/a\/b[{}]/g`,
      after: "/replacement/u",
    }),
  ).toThrow("found 0");
  expect(() =>
    applyMutation("const pattern = /a b/;", {
      before: "/ab/",
      after: "/replacement/",
    }),
  ).toThrow("found 0");
});

it("division and division assignment keep their operator tokens", () => {
  const source = "let value = numerator / denominator; value /= divisor;";
  expect(
    applyMutation(source, {
      before: "numerator/denominator",
      after: "1",
    }),
  ).toBe("let value = 1; value /= divisor;");
  expect(
    applyMutation(source, {
      before: "value/=divisor",
      after: "value=2",
    }),
  ).toBe("let value = numerator / denominator; value=2;");
});

it("nested template expressions distinguish regex braces, raw text and division", () => {
  const source =
    'const output = `outer ${ `inner ${ /[{}]/.test(input) ? numerator / denominator : "fallback" }` }`;';
  expect(applyMutation(source, { before: "/[{}]/", after: "/replacement/" })).toBe(
    source.replace("/[{}]/", "/replacement/"),
  );
  expect(applyMutation(source, { before: "numerator/denominator", after: "1" })).toBe(
    source.replace("numerator / denominator", "1"),
  );
  expect(() => applyMutation(source, { before: "inner", after: "changed" })).toThrow("found 0");
});

it("partial logical anchors retain regex context and invalid sources fail closed", () => {
  const source = "const valid = initial || /call.run()/u.test(input);";
  expect(
    applyMutation(source, {
      before: "||/call.run()/u.test(input)",
      after: "||false",
    }),
  ).toBe("const valid = initial ||false;");
  expect(() =>
    applyMutation("const value = ;", {
      before: "value",
      after: "changed",
    }),
  ).toThrow("Cannot parse mutation source");
  expect(() =>
    applyMutation(source, {
      before: "const pattern=/unterminated",
      after: "false",
    }),
  ).toThrow("Cannot parse mutation fragment");
});
