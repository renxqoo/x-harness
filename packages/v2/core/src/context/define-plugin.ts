import type { PluginContext, PluginManifest, PluginSpec, TokenMap } from "../contracts/plugin-types";
import type { Context, Plugin } from "../contracts/types";
import { readData } from "../contracts/read-data";
import { createFault } from "../contracts/create-fault";
import { createPluginContext } from "./create-plugin-context";

export function definePlugin<const M extends PluginManifest = Record<never, never>>(spec: PluginSpec<M>): Plugin {
  const parsed = readData(spec);
  if (!parsed.ok || Object.keys(parsed.value).some((key) => !["name", "requires", "provides", "optional", "setup"].includes(key)) ||
      typeof parsed.value.setup !== "function") return Object.freeze({ name: "", setup: () => createFault("invalid-definition") });
  const data = parsed.value;
  const requires = readData(data.requires ?? {});
  const provides = readData(data.provides ?? {});
  const optional = readData(data.optional ?? {});
  if (!requires.ok || !provides.ok || !optional.ok) return Object.freeze({ name: "", setup: () => createFault("invalid-definition") });
  const declaration = Object.freeze({
    name: data.name as string,
    requires: Object.freeze(requires.value) as TokenMap,
    provides: Object.freeze(provides.value) as TokenMap,
    optional: Object.freeze(optional.value) as TokenMap,
  });
  const setup = data.setup as (context: PluginContext<M>) => ReturnType<Plugin["setup"]>;
  return Object.freeze({
    ...declaration,
    setup(context: Context) { return setup(createPluginContext<M>(context, declaration)); },
  });
}
