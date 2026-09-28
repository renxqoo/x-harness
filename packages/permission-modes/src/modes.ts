// V4 五档内置模式插件（docs/PERMISSION-V4-DESIGN.md §1-2）：full/plan-default 实现短路面
// decide（规则引擎前整线策略）；auto/edit-confirm/sandboxed-auto 实现尾段面 posture
// （规则引擎后：界内放行/分类器三态/opaque 围栏代问）。行为等价锚 = V3 旋钮梯逐分支。

import type { AdjudicationFacts, Decision, ModePlugin, PermissionProfile } from "@x-harness/permission";
import { classifyPipeline } from "./classifier.ts";

const allow = (reason: string, resolvedBy: string): Decision => ({ verdict: "allow", reason, resolvedBy });
const ask = (reason: string, resolvedBy: string, extra: { memorizable?: true; suggestedRule?: string } = {}): Decision =>
  ({ verdict: "ask", reason, resolvedBy, ...(extra.memorizable === true ? { memorizable: true } : {}), ...(extra.suggestedRule !== undefined ? { suggestedRule: extra.suggestedRule } : {}) });
const deny = (reason: string, resolvedBy: string): Decision => ({ verdict: "deny", reason, resolvedBy });

/** 分类三态自算（V4 #7b：分类是 auto 风险偏好——本包 classifier 持词表） */
const classOf = (facts: AdjudicationFacts): "readonly" | "write" | "unclassified" =>
  classifyPipeline(facts.segments ?? [], facts.hasOutputRedirect === true, facts.roots ?? []);

/** full：提权拒 + 其余全放行（exec 由 base 出口按 containment 附加——tool/path direct、bash 执行面重算） */
export const fullMode: ModePlugin = {
  id: "full",
  unrestricted: true,
  decide: (facts) => {
    if (facts.elevation === true) return deny("hard-deny:sudo", "mode:full");
    if (facts.kind === "Danger") return allow("full mode", "mode:full");
    return allow("full mode", "mode:full");
  },
};

/** auto 尾段姿态：界内放行（读+写 in-root）/bash 分类器 readonly·write 放行；未分类让位终态 ask。
 *  edit-confirm/sandboxed-auto/plan 读面复用本件的界内读姿（P-mix-4「plan 读面=auto 语义」显式化） */
export const autoMode: ModePlugin = {
  id: "auto",
  posture: (facts) => {
    if (facts.face === "path") {
      if (facts.pathAbsent === true) return ask(`path-absent:${facts.tool}`, "path-absent"); // 净化 #6：缺参显式问（不默默按界内放行）
      if (facts.inRoot === true) return allow("in-root", "auto");
      // 界外：ask + 记忆 + 授权富化（P-mix-5 缺省策略显式化）。P-bug-3：父目录为 "/"
      // 不挂 root grant（一次批准≠unrestricted）。P-bug-4b：读族不挂 root grant——
      // 读授权不得扩成写授权（持久化走建议规则，作用域仅读族）
      if (facts.path === undefined || facts.kind === undefined) return undefined;
      const dir = facts.path.slice(0, Math.max(facts.path.lastIndexOf("/"), 1));
      const rootGrantable = dir !== "/" && facts.kind === "Write";
      // R4/内核#3（2026-09-28）：顶层目录（dir==="/"）的 dir/** 模板拼出 `//**` ≡ 全盘
      // 授权——P-bug-3 同闸，降级为精确路径规则（不泛化）。
      // glob 注入（2026-09-29 红队 P2-4）：dir/path 含 glob 元字符（* ? [）时模板拼接会
      // 意外泛化（/w/x*y/** 放行 xZZZy/）——降级为字面转义精确路径（[] 包裹元字符）
      const hasGlobMeta = (s: string): boolean => s.includes("*") || s.includes("?") || s.includes("[");
      const literalPath = facts.path.replace(/\*/g, "[*]").replace(/\?/g, "[?]").replace(/\[/g, "[[]");
      const suggested = dir === "/" || hasGlobMeta(dir)
        ? `${facts.kind}(${literalPath}):allow`
        : `${facts.kind}(${dir}/**):allow`;
      return {
        verdict: "ask" as const,
        reason: `outside-root:${facts.path}`,
        resolvedBy: "outside-root",
        ...(rootGrantable ? { grant: { kind: "extraRoot" as const, dir } } : {}),
        memorizable: true as const,
        suggestedRule: suggested,
      };
    }
    if (facts.face !== "bash") return undefined; // tool 面未知工具 → base 终态 ask
    if ((facts.segments ?? []).some((cmd) => cmd.opaque !== undefined)) return undefined; // 不透明段：非 sandboxed 姿态让位 base opaque ask（旧梯序：opaque 先于分类器）
    const cls = classOf(facts);
    if (cls === "readonly") return allow("classifier:readonly", "classifier:readonly");
    if (cls === "write") return allow("classifier:in-root-write", "classifier:in-root-write");
    return undefined; // unclassified / opaque → base 终态 ask
  },
};

/** edit-confirm 尾段姿态：界内写问（confirm-all）；读面/界外同 auto（复用其 posture 语义） */
export const editConfirmMode: ModePlugin = {
  id: "edit-confirm",
  posture: (facts) => {
    if (facts.face === "path") {
      if (facts.pathAbsent === true) return ask(`path-absent:${facts.tool}`, "path-absent"); // F3：缺参守卫先于写问（与 auto 同口径）
      if (facts.inRoot === true && facts.kind === "Write") {
        // F2（2026-09-28）：建议串补 verdict 尾（旧缺 :allow——批准+记忆档落账 parse 抛
        // internal、写不执行）；root 尾斜杠归一防 //** 全盘形
        return ask("edit-confirm: in-root write", "edit-confirm", { memorizable: true, suggestedRule: `Write(${(facts.root ?? "/").replace(/\/+$/, "")}/**):allow` });
      }
    }
    if (facts.kind === "Danger" && classOf(facts) === "write") {
      return ask("edit-confirm: in-root write", "edit-confirm", { memorizable: true }); // V3 梯 bash 写面 confirm-all 同款
    }
    return autoMode.posture?.(facts);
  },
};

/** sandboxed-auto 尾段姿态：on-failure 围栏代问——opaque/未分类整线 allow（contained 由 base
 *  出口按 containment 附加）；其余同 auto（readonly/write 放行、界内放行） */
export const sandboxedAutoMode: ModePlugin = {
  id: "sandboxed-auto",
  escalatable: true, // P-mix-8：contained 执行的 on-failure 升级资格（注册表表达）
  posture: (facts) => {
    if (facts.kind === "Danger" && (classOf(facts) === "unclassified" || (facts.segments ?? []).some((cmd) => cmd.opaque !== undefined))) {
      return allow("classifier:unclassified (fenced)", "classifier:unclassified");
    }
    return autoMode.posture?.(facts);
  },
};

/** plan 严格缺省（tool-plan 缺席世界保底）：Write 拒 + bash 全拒 + 提权/解析失败细分拒；
 *  读面/未知工具复用 auto 姿态。富策略（tool-plan/planMode）经注册表同 id 后者胜覆盖 */
export const planDefaultMode: ModePlugin = {
  id: "plan",
  decide: (facts) => {
    if (facts.face === "path" && facts.kind === "Write") return deny("plan mode disallows write", "mode:plan");
    if (facts.kind === "Danger") {
      if (facts.parseFailed !== undefined) return deny("plan mode: command not parseable", "mode:plan");
      if (facts.elevation === true || facts.hardDenyKind !== undefined) return deny("plan mode: elevation denied", "mode:plan");
      return deny("plan mode disallows bash", "mode:plan");
    }
    return undefined;
  },
  posture: autoMode.posture, // 读面：界内放行/界外终态 ask（V3 梯子语义显式化）
};

/** 旋钮映射（custom profiles 承接——C-custom-5 五分支的显式化）：行旋钮 → 内置件双面。
 *  full 等价（never+none）→ full；plan-deny → plan-default；on-failure+fenced →
 *  sandboxed-auto；confirm-all → edit-confirm；其余 → auto */
export interface KnobDecide {
  readonly decide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly posture?: (facts: AdjudicationFacts) => Decision | undefined;
}

export function knobDecideOf(profile: { readonly askPolicy: string; readonly containment: string; readonly mutationPolicy?: string }): KnobDecide {
  // P1-2（2026-09-28）：收紧旋钮优先于 full 短路——`{never,none,plan-deny}` 旧映射落
  // fullMode（声明收紧得最宽，意图反转）；矛盾组合另由 profileRowValid 拒收。
  // always 收紧（2026-09-29 红队 P1-1）：`{always,*,auto-in-root}` 旧落 autoMode 界内写
  // 零交互——与「恒问」意图反转；映射 edit-confirm（写面恒问，读面 auto）
  if (profile.mutationPolicy === "plan-deny") return planDefaultMode;
  if (profile.mutationPolicy === "confirm-all") return editConfirmMode;
  if (profile.askPolicy === "always") return editConfirmMode;
  if (profile.askPolicy === "never" && profile.containment === "none") return fullMode;
  if (profile.askPolicy === "on-failure" && profile.containment === "fenced") return sandboxedAutoMode;
  return autoMode;
}


/** 档位解析（V4 #7a 迁自 base/profiles.ts——内置行知识归模式包）：内置 > 自定义；
 *  未知 → undefined（调用方显式处置——plugin 层断代告警） */
export function resolveProfile(id: string, customRows?: readonly PermissionProfile[]): PermissionProfile | undefined {
  const builtin = BUILTIN_PROFILES.find((p) => p.id === id);
  if (builtin !== undefined) return builtin;
  if (customRows !== undefined) {
    const custom = customRows.find((p) => p.id === id);
    if (custom !== undefined) return custom;
  }
  return undefined;
}

/** 出厂档位行（V4 #7a：模式身份数据归本包——base 的 profiles.ts 只留词表/校验） */
export const BUILTIN_PROFILES: readonly PermissionProfile[] = [
  { id: "plan", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" },
  { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "edit-confirm", askPolicy: "on-opaque", containment: "none", mutationPolicy: "confirm-all" },
  { id: "full", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "sandboxed-auto", askPolicy: "on-failure", containment: "fenced", mutationPolicy: "auto-in-root" },
];
