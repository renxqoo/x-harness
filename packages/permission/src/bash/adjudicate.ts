// bash 裁决管线（docs/EXEC-ENV.md §5）：注入(ask) → 段解析(unparseable→ask) → 逐段
// [deny 规则 → 硬拒 ask → dynamic(auto:ask/full:过) → 重定向越界 ask → allow 规则 → 未配(auto:ask/full:过)]
// → 全段允许后 needs_network → ask network。deny 压过 allow；硬拒底线恒 ask（allow 规则不可越过）。

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { FenceFacts, ModeKnob, PermissionRule, Verdict } from "../types.ts";
import { bashRuleMatches } from "../rules/bash-prefix.ts";
import { parseSegments } from "./segments.ts";
import type { Segment } from "./segments.ts";
import { detectInjection } from "./injection.ts";
import { hardDeny } from "./hard-deny.ts";
import { redirectsOf, withoutRedirects, DEV_NULL } from "./redirect.ts";

export interface BashAdjudication {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
}

export interface BashPipelineInput {
  readonly command: string;
  readonly needsNetwork?: boolean;
  readonly rules: readonly PermissionRule[];
  readonly mode: ModeKnob;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
}

export function writableRoots(input: { readonly root: string; readonly extraRoots: readonly string[]; readonly fence?: FenceFacts }): string[] {
  return [input.root, ...input.extraRoots, ...(input.fence?.writable ?? [])].map((p) => resolve(p));
}

/** 路径段边界前缀判定（防 /w/app vs /w/appdir 混淆） */
export function withinAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

/** 重定向目标归一：~ 展开 + root 相对解析 */
function targetPath(target: string, root: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  return resolve(root, target);
}

/** 单段裁决：返回 adjudication = 管线在此终止；undefined = 段通过（继续） */
function segmentDecision(segment: Segment, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | undefined {
  if (segment.words.length === 0) return undefined;
  const commandWords = withoutRedirects(segment.words); // 规则/硬拒匹配命令本体（不含 redirection 语法）
  const denied = bashRuleMatches(input.rules, commandWords).find((rule) => rule.verdict === "deny");
  if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  const hard = hardDeny(commandWords, segment.text);
  if (hard !== undefined) return { verdict: "ask", reason: `hard-deny:${hard}`, resolvedBy: "hard-deny" };
  if (segment.dynamic) {
    // full 档：除 deny 规则与硬拒外全过（仍受围栏）；否则静态不可裁决 → ask
    if (input.mode !== "full") return { verdict: "ask", reason: "dynamic-segment (expansion/glob)", resolvedBy: "static" };
    return undefined;
  }
  for (const redirect of redirectsOf(segment.text)) {
    if (redirect.target === undefined || redirect.target === DEV_NULL) continue; // 2>&1 无目标；/dev/null 围栏许可
    const path = targetPath(redirect.target, input.root);
    if (!withinAny(path, roots)) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect" };
  }
  const allowed = bashRuleMatches(input.rules, commandWords).some((rule) => rule.verdict === "allow");
  if (allowed) return undefined;
  if (input.mode === "full") return undefined;
  // 界内合成（§5 步 5）：围栏在场 + 段静态（非 dynamic）+ 重定向已全在界内 → auto-allow 零交互；
  // 无围栏装配时永不界内 auto（§6 对照句——bash 缺省 ask/deny）
  if (input.fence !== undefined) return undefined;
  return { verdict: "ask", reason: "no rule matches segment", resolvedBy: "default:ask" };
}

export function adjudicateBash(input: BashPipelineInput): BashAdjudication {
  if (input.mode === "plan") return { verdict: "deny", reason: "plan mode disallows bash", resolvedBy: "mode:plan" };
  const injection = detectInjection(input.command);
  if (injection !== undefined) return { verdict: "ask", reason: `injection:${injection}`, resolvedBy: "injection" };
  const parsed = parseSegments(input.command);
  if (!parsed.ok) return { verdict: "ask", reason: "unparseable command", resolvedBy: "parse" };
  const roots = writableRoots(input);
  for (const segment of parsed.segments) {
    const blocked = segmentDecision(segment, input, roots);
    if (blocked !== undefined) return blocked;
  }
  if (input.needsNetwork === true) return { verdict: "ask", reason: "network", resolvedBy: "needs_network" };
  return { verdict: "allow", reason: "in-fence", resolvedBy: input.fence !== undefined ? "auto:fence" : "auto" };
}
