import type { DefinitionRef, Result, Validator } from "./types";
import { createFault } from "./create-fault";
import { readData } from "./read-data";
import { definitionData } from "./definition-data";
import type { MethodData } from "./definition-data";

function readValidators(input: unknown): Result<MethodData> {
  const data = readData(input);

  if (!data.ok) return createFault("invalid-definition");

  const output: Record<string, Validator<unknown>> = Object.create(null);

  for (const key of Object.keys(data.value)) {
    const value = data.value[key];

    if (!["input", "output", "failure"].includes(key) || typeof value !== "function") {
      return createFault("invalid-definition");
    }

    output[key] = value as Validator<unknown>;
  }

  return { ok: true, value: Object.freeze(output) };
}

export function createDefinition(
  kind: DefinitionRef["kind"],
  input: unknown,
): Result<DefinitionRef> {
  const read = readData(input);

  if (!read.ok) return createFault("invalid-definition");

  const data = read.value;
  const name = data.name;

  if (
    typeof name !== "string" ||
    name.length > 160 ||
    name.startsWith("core/") ||
    !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(name)
  ) {
    return createFault("invalid-definition");
  }

  const methods: Record<string, MethodData> = Object.create(null);
  let validators: MethodData = {};

  if (kind === "service") {
    const methodMap = readData(data.methods);

    if (!methodMap.ok || Object.keys(methodMap.value).length === 0)
      return createFault("invalid-definition");

    for (const key of Object.keys(methodMap.value)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ||
        ["then", "constructor", "prototype"].includes(key)
      ) {
        return createFault("invalid-definition");
      }

      const method = readValidators(methodMap.value[key]);

      if (!method.ok) return method;

      methods[key] = method.value;
    }
  } else {
    const raw: Record<string, unknown> = {};

    if (kind === "event") raw.input = data.payload;
    else raw.input = data.input;

    if (kind === "chain") raw.output = data.output;

    const parsed = readValidators(raw);

    if (!parsed.ok) return parsed;

    validators = parsed.value;
  }

  const token = Object.freeze({ kind, name });
  definitionData.set(
    token,
    Object.freeze({ token, methods: Object.freeze(methods), ...validators }),
  );
  return { ok: true, value: token };
}
