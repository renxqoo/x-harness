// permission-modes 插件（V4 §1）：注册五档内置件 + provide profileDecideOf（base 的
// token 消费面——plugin.ts 执行期旋钮回退，纯机制不持策略）。softInject permission——
// 注册表在场才注册（无 permission 世界优雅缺席）。

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
        // M1（2026-09-28）：modeRegistry 缺席=装配序异常（permission 未先 apply——softInject
        // topo 被绕过）。五档不注册 + unrestricted/escalatable 静默丢失——显式告警非静默降级
        process.stderr.write("permission-modes: modeRegistry absent at apply (permission plugin must apply first — loadPlugins topo)\n");
      }
      const offs = registry === undefined ? [] : [
        registry.register(fullMode),
        registry.register(autoMode),
        registry.register(editConfirmMode),
        registry.register(sandboxedAutoMode),
        registry.register(planDefaultMode),
      ];
      // 注册后重同步总括授权：permission 先 apply（注册表当时空）——补一次 set 同值触发
      // setUnrestricted 经注册表重算（幂等；mode 值不变）
      const modeService = ctx.tryUse(permissionMode);
      if (modeService !== undefined) modeService.set(modeService.get());
      // 双服务 provide：档位解析 + 旋钮→模式件映射（knobDecideOf 单源——内联副本已并，
      //  基线拒止面 2026-09-28 C① 内核化，本包不再 provide 基线）
      const offResolveProfile = ctx.provide(resolveProfileOf, resolveProfile);
      const offResolve = ctx.provide(profileDecideOf, knobDecideOf);
      return () => {
        offResolveProfile();
        offResolve();
        for (const off of offs) off();
      };
    },
  };
}
