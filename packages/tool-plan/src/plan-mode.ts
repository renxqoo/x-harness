import type { AdjudicationFacts, Decision } from "@x-harness/permission";
import { classifyPipeline } from "@x-harness/permission-modes";
import type { ModePlugin } from "@x-harness/permission";

const deny = (reason: string): Decision => ({ verdict: "deny", reason, resolvedBy: "mode:plan" });

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
      return undefined;
    }
    if (facts.face !== "bash") return undefined;
    return planSegmentDenials(facts) ?? planClassTail(facts);
  },
};
