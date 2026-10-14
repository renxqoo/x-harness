import type { DefinitionData } from "../contracts/definition-data";
import type { Result } from "../contracts/types";
import type { Provider } from "../runtime/types";
import { createFault } from "../contracts/create-fault";
import { readData } from "../contracts/read-data";

export function prepareImplementation(definition: DefinitionData, input: unknown): Result<Pick<Provider, "implementation" | "terminal">> {
  if (definition.token.kind === "service") {
    const read = readData(input);
    if (!read.ok) return read;
    const names = Object.keys(definition.methods);
    if (Object.keys(read.value).length !== names.length || names.some((name) => typeof read.value[name] !== "function")) {
      return createFault("invalid-input");
    }
    return { ok: true, value: { implementation: Object.freeze(read.value) as Provider["implementation"] } };
  }
  if (definition.token.kind === "chain") {
    if (typeof input !== "function") return createFault("invalid-input");
    const terminal = input as (value: unknown, call: unknown) => unknown;
    return { ok: true, value: { terminal: (value, _next, call) => terminal(value, call) } };
  }
  if (input !== undefined) return createFault("invalid-input");
  return { ok: true, value: {} };
}
