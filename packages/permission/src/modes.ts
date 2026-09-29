import { defineService } from "@x-harness/core";
import type { Disposer } from "@x-harness/core";
import type { AdjudicationFacts } from "./facts.ts";
import type { Decision } from "./decide.ts";
import type { PermissionProfile } from "./types.ts";

export interface ModePlugin {
  readonly id: string;
  decide?(facts: AdjudicationFacts): Decision | undefined;
  posture?(facts: AdjudicationFacts): Decision | undefined;
  readonly unrestricted?: true;
  readonly escalatable?: true;
}

export interface ModeRegistry {
  register(plugin: ModePlugin): Disposer;
  resolve(id: string): ModePlugin | undefined;
}

export const modeRegistry = defineService<ModeRegistry>("permission/mode-registry");

export interface ModeFaces {
  readonly decide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly posture?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly escalatable?: true;
}

export const resolveProfileOf = defineService<(id: string, customRows?: readonly PermissionProfile[]) => PermissionProfile | undefined>("permission/resolve-profile");

export const profileDecideOf = defineService<(profile: { readonly askPolicy: string; readonly containment: string; readonly mutationPolicy?: string }) => ModeFaces>("permission/profile-decide-of");

export function createModeRegistry(): ModeRegistry {
  const byId = new Map<string, { readonly plugin: ModePlugin; readonly identity: object }>();
  return {
    register: (plugin) => {
      if (typeof plugin?.id !== "string" || plugin.id === "") throw new Error("mode plugin id must be a non-empty string");
      if (typeof plugin.decide !== "function" && typeof plugin.posture !== "function") throw new Error(`mode plugin "${plugin.id}" must implement decide or posture`);
      const identity = {};
      byId.set(plugin.id, { plugin, identity });
      return () => {
        if (byId.get(plugin.id)?.identity === identity) byId.delete(plugin.id);
      };
    },
    resolve: (id) => byId.get(id)?.plugin,
  };
}
