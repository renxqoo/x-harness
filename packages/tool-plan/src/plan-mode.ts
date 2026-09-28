// plan 模式富策略（V3 阶段二——P-mix-12 迁移：planBash 语义整体迁入本包，消费
// bashFactsOf 事实不自聚合——B-bug-1/5 的结构性根治）。注册经 modeRegistry 同 id 后
// 注册者胜 → 覆盖 permission 内置的 planDefaultMode（严格缺省）。
// 与 permission 时代 planBash 的行为映射（有意变更全录——IMPLEMENTATION 偏离记录）：
// ① deny 规则由核心先行、resolvedBy 从 mode:plan 改 rule:<origin>（U7 同族）；
// ② dynamic 段拒绝（U5 B-bug-5——旧 planBash 缺此面）；③ 读保护各维从逐段交错改
// facts 聚合统一序（deny-vs-deny 的 reason 差、verdict 不变）：
// ① 段旗面（injection/结构失格/opaque/dynamic）与提权面拒；② 读保护基线（输入重定向
// 拒读表 + argv 敏感面——B-bug-1）；③ 输出重定向拒 + 分类器三态（readonly 放行/其余拒）。

import type { AdjudicationFacts, Decision } from "@x-harness/permission";
import { classifyPipeline } from "@x-harness/permission-modes";
import type { ModePlugin } from "@x-harness/permission";

const deny = (reason: string): Decision => ({ verdict: "deny", reason, resolvedBy: "mode:plan" });

/** 段旗面（injection/结构失格/opaque/dynamic）与提权/读基线/重定向的拒序（B-bug-1/5） */
function planSegmentDenials(facts: AdjudicationFacts): Decision | undefined {
  if (facts.parseFailed !== undefined) return deny("plan mode: command not parseable");
  for (const cmd of facts.segments ?? []) {
    if (cmd.injection !== undefined) return deny("plan mode: injection form denied");
    if (cmd.ask !== undefined) return deny("plan mode: structurally unadjudicable");
    if (cmd.opaque !== undefined) return deny(`plan mode: opaque segment (${cmd.opaque})`);
    if (cmd.dynamic) return deny("plan mode: dynamic (shell-expanded) segment denied");
  }
  if (facts.elevation === true || facts.hardDenyKind !== undefined) return deny("plan mode: elevation denied");
  if (facts.redirectUnresolvable === true) return deny("plan mode: unreadable redirect target");
  if (facts.redirectReadDeny !== undefined) return deny(`redirect-read:${facts.redirectReadDeny}`);
  if (facts.sensitiveHit !== undefined) return deny(`plan mode: sensitive path (${facts.sensitiveHit.kind}:${facts.sensitiveHit.pattern})`);
  if (facts.hasOutputRedirect === true) return deny("plan mode: output redirect denied");
  return undefined;
}

/** 分类器三态尾段：readonly 放行（研究通道）/其余拒 */
function planClassTail(facts: AdjudicationFacts): Decision {
  const cls = classifyPipeline(facts.segments ?? [], facts.hasOutputRedirect === true, facts.roots ?? []);
  if (cls === "readonly") return { verdict: "allow", reason: "classifier:readonly (plan)", resolvedBy: "classifier:readonly" };
  return deny(cls === "write" ? "plan mode disallows bash write" : "plan mode: command not read-only classified");
}

export const planMode: ModePlugin = {
  id: "plan",
  decide: (facts: AdjudicationFacts): Decision | undefined => {
    if (facts.face === "path") {
      if (facts.kind === "Write") return deny("plan mode disallows write");
      return undefined; // Read/Grep → 核心 fallback（界内放行/界外 ask）
    }
    if (facts.face !== "bash") return undefined; // tool 面未知工具 → 核心 fallback 保守 ask
    return planSegmentDenials(facts) ?? planClassTail(facts);
  },
};
