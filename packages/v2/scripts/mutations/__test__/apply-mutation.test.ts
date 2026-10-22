import { expect, it } from "vitest";
import { applyMutation } from "../apply-mutation";

it("formatted arrows and trailing commas still mutate the original token span", () => {
  const source =
    "prefix();\nconst accepted = entries.map(\n  (entry) => ({\n    value: entry.value,\n  }),\n);\nsuffix();\n";
  expect(
    applyMutation(source, {
      before: "const accepted=entries.map(entry=>({value:entry.value}));",
      after: "const accepted=[];",
    }),
  ).toBe("prefix();\nconst accepted=[];\nsuffix();\n");
});

it("quote normalization preserves meaningful whitespace inside string values", () => {
  expect(
    applyMutation("const message = 'keep  gap';", {
      before: 'const message="keep  gap";',
      after: 'const message="changed";',
    }),
  ).toBe('const message="changed";');
  expect(() =>
    applyMutation('read.file("ab");', {
      before: "read.file('a b')",
      after: "undefined",
    }),
  ).toThrow("found 0");
});

it("raw mode mutates template content without parsing it as TypeScript", () => {
  const source = "export const rules = `(deny process-fork)\\n`;";
  expect(
    applyMutation(source, {
      before: "(deny process-fork)",
      after: "(allow process-fork)",
      mode: "raw",
    }),
  ).toBe("export const rules = `(allow process-fork)\\n`;");
  expect(() =>
    applyMutation(source, {
      before: "(deny process-fork)",
      after: "(allow process-fork)",
    }),
  ).toThrow("found 0");
});

it("explicit counts retain intentional multiple replacements and reject silent drift", () => {
  const source = "cell.current = undefined;\ncell.current=undefined;\n";
  const edit = { before: "cell.current=undefined;", after: "", expectedMatches: 2 };
  expect(applyMutation(source, edit)).toBe("\n\n");
  expect(() => applyMutation(source, { ...edit, expectedMatches: 1 })).toThrow("found 2");
  expect(() => applyMutation(source, { ...edit, expectedMatches: 3 })).toThrow("found 2");
  expect(() => applyMutation(source, { before: " \n ", after: "" })).toThrow("must not be empty");
  expect(() => applyMutation(source, { before: " ", after: "", mode: "raw" })).toThrow(
    "must not be empty",
  );
});

it("token boundaries prevent partial identifier and string fragment replacements", () => {
  expect(() => applyMutation("counter = 1;", { before: "count", after: "other" })).toThrow(
    "found 0",
  );
  expect(() =>
    applyMutation('text = "call.run()";', { before: "call.run()", after: "false" }),
  ).toThrow("found 0");
  expect(() =>
    applyMutation("const slots = [,];", { before: "slots=[]", after: "slots=[1]" }),
  ).toThrow("found 0");
  expect(() =>
    applyMutation("const slots = [1,,];", { before: "slots=[1,]", after: "slots=[1]" }),
  ).toThrow("found 0");
});
