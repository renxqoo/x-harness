import { validatePlugin } from "../../core/src/index";
import type { DefinitionRef, Plugin, Result } from "../../core/src/index";
import { createFault } from "../../core/src/validation";
import type { PlannedPlugin, PluginPlan } from "./types";

export function planPlugins(input: readonly Plugin[], maximum: number): Result<PluginPlan> {
  try {
    if (!Array.isArray(input)) return createFault("invalid-input");

    if (input.length > maximum) return createFault("resource-limit");

    const entries = new Map<string, PlannedPlugin>();
    const providers = new Map<object, string>();
    const identities = new Map<string, DefinitionRef>();

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (!descriptor || !("value" in descriptor)) return createFault("invalid-input");

      const validated = validatePlugin(descriptor.value);

      if (!validated.ok) return validated;

      const spec = validated.value;

      if (entries.has(spec.name)) return createFault("definition-conflict");

      entries.set(spec.name, { source: descriptor.value as Plugin, spec });

      for (const token of [
        ...Object.values(spec.requires!),
        ...Object.values(spec.optional!),
        ...Object.values(spec.provides!),
      ]) {
        const existing = identities.get(token.name);

        if (existing && existing !== token) return createFault("definition-conflict");

        identities.set(token.name, token);
      }

      for (const token of Object.values(spec.provides!)) {
        if (providers.has(token)) return createFault("duplicate-provider");

        providers.set(token, spec.name);
      }
    }

    const ordered: PlannedPlugin[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (entry: PlannedPlugin): boolean => {
      if (visited.has(entry.spec.name)) return true;

      if (visiting.has(entry.spec.name)) return false;

      visiting.add(entry.spec.name);

      for (const token of [
        ...Object.values(entry.spec.requires!),
        ...Object.values(entry.spec.optional!),
      ]) {
        const name = providers.get(token);

        if (name && !visit(entries.get(name)!)) return false;
      }

      visiting.delete(entry.spec.name);
      visited.add(entry.spec.name);
      ordered.push(entry);
      return true;
    };

    for (const entry of entries.values()) if (!visit(entry)) return createFault("dependency-cycle");

    return { ok: true, value: { entries: ordered, providers } };
  } catch {
    return createFault("invalid-input");
  }
}
