import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { FenceFacts, PermissionProfile, PermissionRule, Verdict } from "../types.ts";
import { globMatch } from "../rules/glob.ts";
import { bashRuleMatches } from "../rules/bash-prefix.ts";
import { parseBash } from "./ast.ts";
import type { BashParse, ParsedCommand } from "./ast.ts";
import { hardDeny } from "./hard-deny.ts";
import { denyTablesOf, denyReadHitOf, denyWritePatternsOf } from "./tables.ts";
import type { BaselinePolicy } from "../baseline.ts";
import { argvSensitiveHit } from "../sensitive.ts";
import { cwdAfter } from "../sensitive.ts";
import { suggestRule, exactRule } from "../suggest.ts";
import type { AdjudicationFacts } from "../facts.ts";
import { bashFactsOf } from "../facts.ts";
import type { Decision } from "../decide.ts";

export interface BashAdjudication {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly memorizable?: true;
  readonly suggestedRule?: string;
}

export interface BashPipelineInput {
  readonly command: string;
  readonly rules: readonly PermissionRule[];
  readonly profile: PermissionProfile;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
  readonly protectedWrite?: readonly string[];
  readonly parse?: (src: string) => BashParse;
  readonly modeDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly postureDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly denyRules?: readonly PermissionRule[];
  readonly unrestricted?: true;
  readonly baseline?: BaselinePolicy;
}

export function writableRoots(input: { readonly root: string; readonly extraRoots: readonly string[]; readonly fence?: FenceFacts }): string[] {
  return [input.root, ...input.extraRoots, ...(input.fence?.writable ?? [])].map((p) => resolve(p));
}

const ELEVATION_WORD = /\b(sudo|doas|su)\b/;

function targetPath(target: string, root: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (/^~[A-Za-z0-9_.-]/.test(target)) return null;
  return resolve(root, target);
}

const DEV_NULL = "/dev/null";

function redirectDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | undefined {
  for (const redirect of cmd.redirects) {
    if (redirect.target === undefined || redirect.target === DEV_NULL) continue;
    const path = targetPath(redirect.target, input.root);
    if (path === null) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect", memorizable: true };
    if (redirect.face === "input") {
      const hit = denyReadHitOf(input, path);
      if (hit !== undefined) return { verdict: "deny", reason: `redirect-read:${hit}`, resolvedBy: "redirect-read" };
      continue;
    }
    const writeHit = denyWritePatternsOf(input).find((pattern) => globMatch(pattern, path, input.root));
    if (writeHit !== undefined) return { verdict: "deny", reason: `redirect-write:${writeHit}`, resolvedBy: "redirect-write" };
    if (!withinAny(path, roots)) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect", memorizable: true };
  }
  return undefined;
}

function withinAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return path === root || path.startsWith(prefix);
  });
}

function commandDecision(cmd: ParsedCommand, input: BashPipelineInput & { cwd: string }, roots: readonly string[]): BashAdjudication | { readonly ruleAllowed: PermissionRule } | undefined {
  if (cmd.argv.length > 0) {
    const matches = bashRuleMatches(input.rules, cmd.argv);
    const denied = matches.find((rule) => rule.verdict === "deny");
    if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
    const hard = hardDeny(cmd.argv);
    if (hard !== undefined) return { verdict: "ask", reason: `hard-deny:${hard}`, resolvedBy: "hard-deny" };
  }
  if (cmd.injection !== undefined) return { verdict: "ask", reason: `injection:${cmd.injection}`, resolvedBy: "injection" };
  if (cmd.ask !== undefined) return { verdict: "ask", reason: cmd.ask, resolvedBy: "wrapper" };
  if (cmd.dynamic) return { verdict: "ask", reason: "dynamic-segment (expansion/glob)", resolvedBy: "static" };
  if (cmd.argv.length === 0) return redirectDecision(cmd, input, roots);
  const blocked = redirectDecision(cmd, input, roots);
  if (blocked !== undefined) return blocked;
  const matches = bashRuleMatches(input.rules, cmd.argv);
  const askRule = matches.find((rule) => rule.verdict === "ask" && rule.nature !== "grant");
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  const allowRule = matches.find((rule) => rule.verdict === "allow" && rule.nature !== "grant");
  if (allowRule !== undefined) return { ruleAllowed: allowRule };
  const sensitive = argvSensitiveHit([cmd], input.cwd, denyTablesOf(input));
  if (sensitive !== undefined) {
    const exactLearned = input.rules.find((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw);
    if (exactLearned !== undefined) return undefined;
    return { verdict: "ask", reason: `argv-sensitive:${sensitive.kind}:${sensitive.pattern}`, resolvedBy: "argv-sensitive", memorizable: true, suggestedRule: exactRule(cmd.raw) };
  }
  return undefined;
}

function bashModeDecision(input: BashPipelineInput): BashAdjudication | undefined {
  const facts = bashFactsOf(input);
  const enriched = facts.parseFailed !== undefined && ELEVATION_WORD.test(input.command) ? { ...facts, elevation: true as const } : facts;
  const decision = input.modeDecide?.(enriched);
  if (decision === undefined) return undefined;
  if (decision.verdict === "allow") {
    if (input.unrestricted !== true && (facts.hardDenyKind !== undefined || facts.parseFailed !== undefined || (facts.segments ?? []).some((cmd) => cmd.injection !== undefined))) {
      return { verdict: "ask", reason: "hard-deny/injection floor", resolvedBy: "red-line:floor" };
    }
    const floor = sensitiveFloorOf(facts.segments ?? [], input);
    if (floor !== undefined) return floor;
  }
  return adjudicationOf(decision);
}

function adjudicationOf(decision: Decision): BashAdjudication {
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    resolvedBy: decision.resolvedBy,
    ...(decision.memorizable === true ? { memorizable: true } : {}),
    ...(decision.suggestedRule !== undefined ? { suggestedRule: decision.suggestedRule } : {}),
  };
}

export function adjudicateBash(input: BashPipelineInput): BashAdjudication {
  const parsed = (input.parse ?? parseBash)(input.command);
  if (!parsed.ok) {
    const failed = bashModeDecision(input);
    if (failed !== undefined) return failed;
    return { verdict: "ask", reason: parsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command", resolvedBy: "parse" };
  }
  const preMode = preModeSweep(parsed.commands, input);
  if (preMode !== undefined) return preMode;
  const modeDecision = bashModeDecision(input);
  if (modeDecision !== undefined) return modeDecision;
  const roots = writableRoots(input);
  let sawRuleAllowed: PermissionRule | undefined;
  const clean: ParsedCommand[] = [];
  let cwd = input.root;
  for (const cmd of parsed.commands) {
    const verdict = commandDecision(cmd, { ...input, cwd }, roots);
    if (typeof verdict === "object" && verdict !== null && "ruleAllowed" in verdict) {
      sawRuleAllowed = verdict.ruleAllowed;
      continue;
    }
    if (verdict !== undefined) return verdict;
    clean.push(cmd);
    cwd = cwdAfter(cmd, cwd);
  }
  return pipelineTail(input, clean, sawRuleAllowed);
}

function sensitiveFactOf(clean: readonly ParsedCommand[], input: BashPipelineInput): { sensitiveHit?: { readonly kind: string; readonly pattern: string } } {
  const hit = argvSensitiveHit(clean, input.root, denyTablesOf(input));
  return hit === undefined ? {} : { sensitiveHit: hit };
}

function pipelineTail(input: BashPipelineInput, clean: readonly ParsedCommand[], sawRuleAllowed: PermissionRule | undefined): BashAdjudication {
  if (clean.length === 0 && sawRuleAllowed !== undefined) return { verdict: "allow", reason: `rule:${sawRuleAllowed.pattern}`, resolvedBy: `rule:${sawRuleAllowed.origin}` };
  for (const cmd of clean) {
    if (cmd.argv.length === 0) continue;
    const learned = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "allow" && rule.nature === "grant")
      ?? input.rules.find((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw);
    if (learned !== undefined) return { verdict: "allow", reason: `grant:${learned.pattern}`, resolvedBy: `grant:${learned.origin}` };
  }
  const hasOutputRedirect = clean.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== DEV_NULL));
  const postureFacts: AdjudicationFacts = {
    face: "bash",
    tool: "bash",
    kind: "Danger",
    segments: clean,
    ...(hasOutputRedirect ? { hasOutputRedirect: true } : {}),
    roots: writableRoots(input),
    root: input.root,
    ...sensitiveFactOf(clean, input),
  };
  const posture = input.postureDecide?.(postureFacts);
  if (posture !== undefined) return adjudicationOf(posture);
  for (const cmd of clean) {
    if (cmd.opaque !== undefined) return { verdict: "ask", reason: cmd.opaque, resolvedBy: "opaque", memorizable: true };
  }
  return { verdict: "ask", reason: "no rule matches segment", resolvedBy: "default:ask", memorizable: true };
}

export function suggestedRuleOf(command: string, parse?: (src: string) => BashParse): string | undefined {
  const parsed = (parse ?? parseBash)(command);
  if (!parsed.ok) return exactRule(command);
  const generalized = suggestRule(parsed);
  return generalized ?? exactRule(command);
}

function preModeSweep(commands: readonly ParsedCommand[], input: BashPipelineInput): BashAdjudication | undefined {
  for (const cmd of commands) {
    if (cmd.argv.length === 0) continue;
    const denied = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "deny");
    if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  }
  for (const cmd of commands) {
    if (cmd.argv.length === 0) continue;
    const askRule = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "ask" && rule.nature !== "grant");
    if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  }
  return redirectFloorOf(commands, input);
}

function redirectFloorOf(commands: readonly ParsedCommand[], input: BashPipelineInput): BashAdjudication | undefined {
  let cwd = input.root;
  for (const cmd of commands) {
    for (const redirect of cmd.redirects) {
      if (redirect.target === undefined || redirect.target === DEV_NULL) continue;
      const path = targetPath(redirect.target, cwd);
      if (path === null) continue;
      if (redirect.face === "input") {
        const readHit = denyReadHitOf(input, path);
        if (readHit !== undefined) return { verdict: "deny", reason: `redirect-read:${readHit}`, resolvedBy: "redirect-read" };
        continue;
      }
      if (input.unrestricted === true) continue;
      const writeHit = denyWritePatternsOf(input).find((pattern) => globMatch(pattern, path, input.root));
      if (writeHit !== undefined) {
        return { verdict: "deny", reason: `redirect-write:${writeHit}`, resolvedBy: "redirect-write" };
      }
    }
    cwd = cwdAfter(cmd, cwd);
  }
  return undefined;
}

function sensitiveFloorOf(commands: readonly ParsedCommand[], input: BashPipelineInput): BashAdjudication | undefined {
  const tables = input.unrestricted === true
    ? { ...denyTablesOf(input), protectedWrite: [] as readonly string[], denyWrite: [] as readonly string[] }
    : denyTablesOf(input);
  let cwd = input.root;
  for (const cmd of commands) {
    const hit = argvSensitiveHit([cmd], cwd, tables);
    if (hit === undefined) {
      cwd = cwdAfter(cmd, cwd);
      continue;
    }
    if (input.unrestricted === true) return { verdict: "deny", reason: `argv-sensitive:${hit.kind}:${hit.pattern}`, resolvedBy: "argv-sensitive" };
    if (cmd.argv.length > 0) {
      if (bashRuleMatches(input.rules, cmd.argv).some((rule) => rule.verdict === "allow" && rule.nature !== "grant")) { cwd = cwdAfter(cmd, cwd); continue; }
      if (input.rules.some((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw)) { cwd = cwdAfter(cmd, cwd); continue; }
    }
    return { verdict: "ask", reason: `argv-sensitive:${hit.kind}:${hit.pattern}`, resolvedBy: "argv-sensitive", memorizable: true, ...(cmd.argv.length > 0 ? { suggestedRule: exactRule(cmd.raw) } : {}) };
  }
  return undefined;
}

export { withinAny };
