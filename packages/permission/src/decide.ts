import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { ToolKind } from "@x-harness/tools";
import type { ExecDirective, FenceFacts, PermissionProfile, PermissionRule, Verdict } from "./types.ts";
import { globMatch } from "./rules/glob.ts";
import type { AdjudicationFacts } from "./facts.ts";
import { adjudicateBash, withinAny } from "./bash/adjudicate.ts";
import { baselineDenyRules } from "./baseline.ts";
import type { BaselinePolicy } from "./baseline.ts";

export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly exec?: ExecDirective;
  readonly grant?: { readonly kind: "extraRoot"; readonly dir: string };
  readonly memorizable?: true;
  readonly suggestedRule?: string;
}

export interface DecideInput {
  readonly tool: string;
  readonly args: unknown;
  readonly modeDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly postureDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly control?: true;
  readonly kind?: ToolKind;
  readonly pathScope?: true;
  readonly session?: SessionId;
  readonly userRules: readonly PermissionRule[];
  readonly projectRules?: readonly PermissionRule[];
  readonly sessionRules: readonly PermissionRule[];
  readonly profile: PermissionProfile;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
  readonly protectedWrite?: readonly string[];
  readonly denyRules?: readonly PermissionRule[];
  readonly unrestricted?: true;
  readonly baseline?: BaselinePolicy;
}

export function execOf(verdict: Verdict, profile: PermissionProfile): ExecDirective | undefined {
  if (verdict !== "allow") return undefined;
  return profile.containment === "fenced" ? "contained" : "direct";
}

export function decideFor(input: DecideInput): Decision {
  if (input.control === true) return { verdict: "allow", reason: "control tool", resolvedBy: "control-tool" };
  const denyRules = [...baselineDenyRules(input.unrestricted === true, input.baseline), ...(input.denyRules ?? [])];
  const rules = [...(input.projectRules ?? []), ...input.userRules, ...denyRules, ...input.sessionRules];
  if (input.kind === "Danger") return decideDangerFace(input, rules, denyRules);
  if (input.kind === "Read" || input.kind === "Write") {
    const baselineRoots = [resolve(input.root), ...input.extraRoots.map((r) => resolve(input.root, r))];
    const pathRoots = [...baselineRoots, ...(input.fence?.writable ?? []).map((p) => resolve(p))];
    return decidePathTool({ ...input, kind: input.kind, rules, roots: pathRoots, baselineRoots });
  }
  return decideToolFace(input, rules);
}

function decideDangerFace(input: DecideInput, rules: readonly PermissionRule[], denyRules: readonly PermissionRule[]): Decision {
  const args = (input.args ?? {}) as { command?: unknown };
  if (typeof args.command !== "string") {
    return { verdict: "ask", reason: "danger:command-absent", resolvedBy: "kind-contract" };
  }
  const adjudication = adjudicateBash({
    command: args.command,
    rules,
    profile: input.profile,
    root: input.root,
    extraRoots: input.extraRoots,
    fence: input.fence,
    ...(input.protectedWrite !== undefined ? { protectedWrite: input.protectedWrite } : {}),
    ...(input.modeDecide !== undefined ? { modeDecide: input.modeDecide } : {}),
    ...(input.postureDecide !== undefined ? { postureDecide: input.postureDecide } : {}),
    denyRules,
    ...(input.unrestricted === true ? { unrestricted: true } : {}),
    ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
  });
  return {
    verdict: adjudication.verdict,
    reason: adjudication.reason,
    resolvedBy: adjudication.resolvedBy,
    ...(execOf(adjudication.verdict, input.profile) !== undefined ? { exec: execOf(adjudication.verdict, input.profile) } : {}),
    ...(adjudication.memorizable === true ? { memorizable: true } : {}),
    ...(adjudication.suggestedRule !== undefined ? { suggestedRule: adjudication.suggestedRule } : {}),
  };
}

function decideToolFace(input: DecideInput, rules: readonly PermissionRule[]): Decision {
  const toolRules = rules.filter((rule) => rule.tool === "Tool" && toolWildcardMatch(rule.pattern, input.tool));
  const denied = toolRules.find((rule) => rule.verdict === "deny");
  if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  const askRule = toolRules.find((rule) => rule.verdict === "ask" && rule.nature !== "grant");
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  const allowed = toolRules.find((rule) => rule.verdict === "allow" && rule.nature !== "grant");
  const modeDecision = input.modeDecide?.({ face: "tool", tool: input.tool, ...(input.kind !== undefined ? { kind: input.kind } : {}) });
  if (modeDecision !== undefined) return withExec(attributeRule(modeDecision, allowed), input.profile);
  if (allowed !== undefined) return allowDecision(`rule:${allowed.pattern}`, `rule:${allowed.origin}`, input.profile);
  return { verdict: "ask", reason: `unknown tool:${input.tool}`, resolvedBy: "default:ask", memorizable: true, suggestedRule: `Tool(${input.tool}):allow` };
}

function toolWildcardMatch(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === tool;
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(tool);
}

interface PathDecisionInput extends DecideInput {
  readonly kind: "Read" | "Write";
  readonly rules: readonly PermissionRule[];
  readonly roots: readonly string[];
  readonly baselineRoots?: readonly string[];
}

function decidePathTool(input: PathDecisionInput): Decision {
  const batch = pathsOf(input);
  if (batch !== undefined) {
    let firstAsk: Decision | undefined;
    for (const entry of batch) {
      const one = decideOnePath(input, entry.path, false);
      if (one.verdict === "deny") return one;
      if (one.verdict === "ask" && firstAsk === undefined) firstAsk = one;
    }
    if (firstAsk !== undefined) return firstAsk;
    return withExec(attributeRule({ verdict: "allow", reason: "batch in-root", resolvedBy: "auto" }, allowRuleOf(input, batch[0]?.path ?? "")), input.profile);
  }
  const single = pathOf(input);
  return decideOnePath(input, single.path, single.absent);
}

function decideOnePath(input: PathDecisionInput, path: string, absent: boolean): Decision {
  const scope = input.pathScope === true && input.kind === "Read";
  const conditional = (rule: PermissionRule): boolean => rule.outsideRoots === true && withinAny(path, input.baselineRoots ?? input.roots);
  const denied = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "deny" && path !== "" && !conditional(rule) && (globMatch(rule.pattern, path, input.root) || (scope && scopeDenyAnchored(rule.pattern, path, input.root))));
  if (denied !== undefined) {
    return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  }

  const inRoot = path !== "" && withinAny(path, input.roots);
  const facts: AdjudicationFacts = { face: "path", tool: input.tool, kind: input.kind, path, inRoot, root: input.root, ...(absent ? { pathAbsent: true } : {}) };
  const askRule = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "ask" && rule.nature !== "grant" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  const shortDecision = input.modeDecide?.(facts);
  if (shortDecision !== undefined) return withExec(attributeRule(shortDecision, allowRuleOf(input, path)), input.profile);
  const allowed = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "allow" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (allowed !== undefined) return allowDecision(`rule:${allowed.pattern}`, `${allowed.nature === "grant" ? "grant" : "rule"}:${allowed.origin}`, input.profile);
  const scopeAsk = scopeDenySoft(input, path, scope);
  if (scopeAsk !== undefined) return scopeAsk;
  const postureDecision = input.postureDecide?.(facts);
  if (postureDecision !== undefined) return withExec(postureDecision, input.profile);
  return { verdict: "ask", reason: `outside-root:${String(((input.args ?? {}) as { path?: unknown }).path ?? "")}`, resolvedBy: "outside-root" };
}

function allowRuleOf(input: PathDecisionInput, path: string): PermissionRule | undefined {
  return input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "allow" && rule.nature !== "grant" && path !== "" && globMatch(rule.pattern, path, input.root));
}

function withExec(decision: Decision, profile: PermissionProfile): Decision {
  if (decision.verdict !== "allow" || decision.exec !== undefined) return decision;
  const exec = execOf("allow", profile);
  return exec === undefined ? decision : { ...decision, exec };
}

function pathOf(input: PathDecisionInput): { readonly path: string; readonly absent: boolean } {
  const args = (input.args ?? {}) as { path?: unknown };
  if (typeof args.path === "string" && args.path !== "") return { path: resolve(input.root, args.path), absent: false };
  return input.pathScope === true ? { path: resolve(input.root), absent: false } : { path: input.root, absent: true };
}

function pathsOf(input: PathDecisionInput): readonly { readonly path: string }[] | undefined {
  const args = (input.args ?? {}) as { paths?: unknown };
  if (!Array.isArray(args.paths) || args.paths.length === 0) return undefined;
  const entries: { path: string }[] = [];
  for (const item of args.paths) {
    if (typeof item !== "string" || item === "") continue;
    entries.push({ path: resolve(input.root, item) });
  }
  return entries.length > 0 ? entries : undefined;
}

function scopeDenySoft(input: PathDecisionInput, path: string, scope: boolean): Decision | undefined {
  if (!scope) return undefined;
  const unanchored = input.rules.find((rule) => rule.tool === "Read" && rule.verdict === "deny" && !(rule.outsideRoots === true && withinAny(path, input.roots)) && unanchoredPattern(rule.pattern));
  return unanchored === undefined ? undefined : { verdict: "ask", reason: `scope-deny:${unanchored.pattern}`, resolvedBy: "scope-deny", memorizable: true, suggestedRule: `Read(${path}):allow` };
}

function unanchoredPattern(pattern: string): boolean {
  const star = pattern.indexOf("*");
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const base = head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
  return base === "" || base === "~";
}

function scopeDenyAnchored(pattern: string, scope: string, root: string): boolean {
  if (unanchoredPattern(pattern)) return false;
  const star = pattern.indexOf("*");
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const base = head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
  const dir = basedirOf(base, root);
  const within = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
  return within(dir, scope) || within(scope, dir);
}

function basedirOf(base: string, root: string): string {
  if (base === "~") return homedir();
  if (base.startsWith("~/")) return resolve(homedir(), base.slice(2));
  return resolve(root, base);
}

function attributeRule(modeDecision: Decision, allowRule: PermissionRule | undefined): Decision {
  if (modeDecision.verdict !== "allow" || allowRule === undefined) return modeDecision;
  return { ...modeDecision, reason: `rule:${allowRule.pattern}`, resolvedBy: `rule:${allowRule.origin}` };
}



function allowDecision(reason: string, resolvedBy: string, profile: PermissionProfile): Decision {
  const exec = execOf("allow", profile);
  return { verdict: "allow", reason, resolvedBy, ...(exec !== undefined ? { exec } : {}) };
}
