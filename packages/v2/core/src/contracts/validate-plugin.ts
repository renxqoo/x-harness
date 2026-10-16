import type { DefinitionRef, Plugin, Result } from "./types";
import { createFault } from "./create-fault";
import { readData } from "./read-data";
import { definitionData } from "./definition-data";

export function validatePlugin(input: unknown): Result<Plugin> {
  const read = readData(input);
  if (!read.ok) return read;
  const data = read.value;
  if (Object.keys(data).some((key) => !["name", "requires", "optional", "provides", "setup"].includes(key)) ||
      typeof data.name !== "string" || data.name.length > 160 || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(data.name) ||
      typeof data.setup !== "function") return createFault("invalid-definition");
  const maps = [data.requires ?? {}, data.optional ?? {}, data.provides ?? {}].map(readData);
  if (maps.some((map) => !map.ok)) return createFault("invalid-definition");
  const values = maps.map((map) => map.ok ? map.value as Record<string, DefinitionRef> : {});
  const tokens = values.flatMap(Object.values);
  const keys = values.flatMap(Object.keys);
  if (keys.some((key) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) || new Set(keys).size !== keys.length ||
      tokens.some((token) => !definitionData.has(token)) || new Set(tokens).size !== tokens.length) return createFault("invalid-definition");
  const identities = new Map<string, DefinitionRef>();
  for (const token of tokens) {
    const existing = identities.get(token.name);
    if (existing && existing !== token) return createFault("definition-conflict");
    identities.set(token.name, token);
  }
  return { ok: true, value: Object.freeze({ name: data.name, setup: data.setup as Plugin["setup"],
    requires: Object.freeze(values[0]!), optional: Object.freeze(values[1]!), provides: Object.freeze(values[2]!),
  }) };
}
