// V4 模式插件协议与注册表（docs/PERMISSION-V4-DESIGN.md §1/§6）：permission 是纯底层
// 机制件——零档位策略（五档内置件在 @x-harness/permission-modes）。两挂点时序契约：
// decide 在 deny 规则后/规则引擎前（full/plan 整线策略）；posture 在规则引擎与段梯后
// /终态前（auto 族尾段姿态）。无模式装配：未显式放行（规则/习得）的一切 → ask（fail-closed）。

import { defineService } from "@x-harness/core";
import type { Disposer } from "@x-harness/core";
import type { AdjudicationFacts } from "./facts.ts";
import type { Decision } from "./decide.ts";
import type { PermissionProfile } from "./types.ts";

/** 模式插件（U1 判决函数形态 + V4 双面扩展） */
export interface ModePlugin {
  readonly id: string;
  /** 短路面：规则引擎之前的整线策略（full/plan 形态）。undefined = 让位继续 */
  decide?(facts: AdjudicationFacts): Decision | undefined;
  /** 尾段姿态：规则引擎与段梯之后（auto 族——界内放行/分类器三态/opaque 围栏代问）。
   *  undefined = 让位 base fail-closed 终态 */
  posture?(facts: AdjudicationFacts): Decision | undefined;
  /** 总括授权属性（P-mix-7——setUnrestricted 的注册表表达） */
  readonly unrestricted?: true;
  /** contained 执行带升级资格（P-mix-8——sandboxed-auto 的 on-failure 升级面注册表达；
   *  执行面查注册表，旋钮读取从 base 消失） */
  readonly escalatable?: true;
}

/** 模式注册表（per-world——permission 插件 apply 期实例化并 provide） */
export interface ModeRegistry {
  register(plugin: ModePlugin): Disposer;
  resolve(id: string): ModePlugin | undefined;
}

export const modeRegistry = defineService<ModeRegistry>("permission/mode-registry");

/** 模式双面（短路面 + 尾段姿态——旋钮解析/knobDecideOf 的返回形） */
export interface ModeFaces {
  readonly decide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly posture?: (facts: AdjudicationFacts) => Decision | undefined;
  /** contained 执行升级资格（旋钮面透传——注册表件与 knob 件同源表达） */
  readonly escalatable?: true;
}

/** 旋钮→模式双面解析服务（base 定义 token、permission-modes provide——base 消费服务
 *  不持策略；plugin.ts 执行期在注册表 id 未命中时回退——custom profiles 的承接面）。
 *  2026-09-28 C①：安全底线表已内核化（baseline.ts），本 token 族不再含基线提供面 */
/** 档位解析服务（base 定义 token、permission-modes provide——BUILTIN_PROFILES+自定义行是
 *  模式层知识）：settings 档位串 → 档对象。服务缺席（裸内核）= 未知档断代落 auto（U3） */
export const resolveProfileOf = defineService<(id: string, customRows?: readonly PermissionProfile[]) => PermissionProfile | undefined>("permission/resolve-profile");

export const profileDecideOf = defineService<(profile: { readonly askPolicy: string; readonly containment: string; readonly mutationPolicy?: string }) => ModeFaces>("permission/profile-decide-of");

export function createModeRegistry(): ModeRegistry {
  const byId = new Map<string, { readonly plugin: ModePlugin; readonly identity: object }>();
  return {
    register: (plugin) => {
      if (typeof plugin?.id !== "string" || plugin.id === "") throw new Error("mode plugin id must be a non-empty string");
      if (typeof plugin.decide !== "function" && typeof plugin.posture !== "function") throw new Error(`mode plugin "${plugin.id}" must implement decide or posture`);
      const identity = {};
      byId.set(plugin.id, { plugin, identity }); // 同 id 后注册者胜（覆盖式）
      return () => {
        if (byId.get(plugin.id)?.identity === identity) byId.delete(plugin.id);
      };
    },
    resolve: (id) => byId.get(id)?.plugin,
  };
}
