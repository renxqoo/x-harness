import type { Disposer, Plugin } from "@x-harness/core";
import { modeRegistry, permissionMode, profileDecideOf, resolveProfileOf } from "@x-harness/permission";
import { autoMode, editConfirmMode, fullMode, knobDecideOf, planDefaultMode, resolveProfile, sandboxedAutoMode } from "./modes.ts";

export function createPermissionModesPlugin(): Plugin {
  return {
    name: "permission-modes",
    softInject: ["permission"],
    apply: (ctx): Disposer => {
      const registry = ctx.tryUse(modeRegistry);
      if (registry === undefined) {
        process.stderr.write("permission-modes: modeRegistry absent at apply (permission plugin must apply first — loadPlugins topo)\n");
      }
      const offs = registry === undefined ? [] : [
        registry.register(fullMode),
        registry.register(autoMode),
        registry.register(editConfirmMode),
        registry.register(sandboxedAutoMode),
        registry.register(planDefaultMode),
      ];
      const modeService = ctx.tryUse(permissionMode);
      if (modeService !== undefined) modeService.set(modeService.get());
      const offResolveProfile = ctx.provide(resolveProfileOf, resolveProfile);
      const offResolve = ctx.provide(profileDecideOf, knobDecideOf);
      return () => {
        offResolveProfile();
        offResolve();
        for (const off of offs) off();
        const modeService2 = ctx.tryUse(permissionMode);
        if (modeService2 !== undefined) modeService2.set(modeService2.get());
      };
    },
  };
}
