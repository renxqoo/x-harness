// bash 裁决管线（docs/PERMISSION-V2-DESIGN.md §3 决策梯）：AST 解析（unparseable/
// parser-unavailable → ask）→ 逐命令 [deny 规则 → 硬拒 ask → injection ask → 结构失败 ask →
// dynamic ask → 重定向双面 → 显式 ask 规则（抑制记忆）→ 显式 allow → argv 敏感面 ask（精确
// 可记忆）→ 习得 allow → opaque → 分类器（readonly/界内写按档/未分类按档）]。
// 拒记集（memorizable=false）：硬拒/injection/结构失败/dynamic/显式 ask 规则——NEVER_MEMORIZE。
// 全档（U11）：硬拒/injection 维持恒 ask 现口径；full 短路维持 PERMISSION-FULL-UNRESTRICTED。
// plan 硬闸（U10）：mutationPolicy=plan-deny 档 bash/Write 无条件 deny，先于一切规则。

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { FenceFacts, PermissionProfile, PermissionRule, Verdict } from "../types.ts";
import { DEFAULT_DENY_READ } from "../types.ts";
import { globMatch } from "../rules/glob.ts";
import { bashRuleMatches } from "../rules/bash-prefix.ts";
import { parseBash } from "./ast.ts";
import type { BashParse, ParsedCommand } from "./ast.ts";
import { hardDeny } from "./hard-deny.ts";
import { classifyPipeline } from "../classifier.ts";
import { argvSensitiveHit } from "../sensitive.ts";
import { suggestRule, exactRule } from "../suggest.ts";

export interface BashAdjudication {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
  /** 可记忆（ask 类）：true=四档记忆选项可用；缺省=拒记（只余 once） */
  readonly memorizable?: true;
  /** 泛化建议规则串（精确兜底由 plugin 层 exactRule 补） */
  readonly suggestedRule?: string;
}

export interface BashPipelineInput {
  readonly command: string;
  readonly rules: readonly PermissionRule[];
  readonly profile: PermissionProfile;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
  /** 宿主保护写路径（settings 文件等——argv 敏感面执法用，U13） */
  readonly protectedWrite?: readonly string[];
  /** 解析器接缝（缺省真 parseBash）——parser-unavailable 裁决级 reason 的测试锚 */
  readonly parse?: (src: string) => BashParse;
}

export function writableRoots(input: { readonly root: string; readonly extraRoots: readonly string[]; readonly fence?: FenceFacts }): string[] {
  return [input.root, ...input.extraRoots, ...(input.fence?.writable ?? [])].map((p) => resolve(p));
}

/** 提权/密码词（full 档畸形命令的原始文本兜底——fail-closed 收敛于提权面） */
const ELEVATION_WORD = /\b(sudo|doas|su)\b/;

/** 重定向目标归一：~ 与 ~/ 展开 + root 相对解析；~user 形不可静态解析（node 无 passwd 面）→ null */
function targetPath(target: string, root: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (/^~[A-Za-z0-9_.-]/.test(target)) return null; // ~root/pwn 类——保守 ask
  return resolve(root, target);
}

const DEV_NULL = "/dev/null";

/** 重定向双面裁决：输出面越根/目标不可解析 → ask（可记忆+精确建议）；输入面命中拒读表 → deny */
function redirectDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | undefined {
  for (const redirect of cmd.redirects) {
    if (redirect.target === undefined || redirect.target === DEV_NULL) continue;
    const path = targetPath(redirect.target, input.root);
    if (path === null) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect", memorizable: true };
    if (redirect.face === "input") {
      const hit = DEFAULT_DENY_READ.find((pattern) => globMatch(pattern, path, input.root));
      if (hit !== undefined) return { verdict: "deny", reason: `redirect-read:${hit}`, resolvedBy: "redirect-read" };
      continue;
    }
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

/** 单命令裁决：adjudication=管线终止；"rule-allowed"=段被显式规则放行（段级终结——
 *  跳过分类器，其余段照常裁决）；undefined=段通过（进分类器）。 */
function commandDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | "rule-allowed" | undefined {
  if (cmd.argv.length > 0) {
    const matches = bashRuleMatches(input.rules, cmd.argv);
    const denied = matches.find((rule) => rule.verdict === "deny");
    if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
    const hard = hardDeny(cmd.argv);
    if (hard !== undefined) return { verdict: "ask", reason: `hard-deny:${hard}`, resolvedBy: "hard-deny" }; // 拒记
  }
  if (cmd.injection !== undefined) return { verdict: "ask", reason: `injection:${cmd.injection}`, resolvedBy: "injection" }; // 拒记
  if (cmd.ask !== undefined) return { verdict: "ask", reason: cmd.ask, resolvedBy: "wrapper" }; // 拒记（结构失败）
  if (cmd.dynamic) return { verdict: "ask", reason: "dynamic-segment (expansion/glob)", resolvedBy: "static" }; // 拒记
  if (cmd.argv.length === 0) return redirectDecision(cmd, input, roots); // 纯重定向宿主——只裁 redirects
  const blocked = redirectDecision(cmd, input, roots);
  if (blocked !== undefined) return blocked;
  const matches = bashRuleMatches(input.rules, cmd.argv);
  // 显式 ask 规则（handwritten）：ask 且抑制记忆（承诺受显式规则约束——学习不越过「要问」）
  const askRule = matches.find((rule) => rule.verdict === "ask" && rule.nature !== "grant");
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  // 显式 allow（handwritten）：用户显式权威——可越过敏感面与不透明面
  const allowRule = matches.find((rule) => rule.verdict === "allow" && rule.nature !== "grant");
  if (allowRule !== undefined) return "rule-allowed";
  // argv 敏感面（U12）：读底线/保护写补偿——强制 ask，精确可记忆；fenced 档交内核执法不问（§4.2 矩阵）
  const sensitive = input.profile.containment === "fenced" ? undefined : argvSensitiveHit([cmd], input.root, input.protectedWrite ?? []);
  if (sensitive !== undefined) {
    // 精确习得豁免：同命令原文的 grant 精确规则放行（U12「精确可记忆」的兑现面——泛化形态不豁免）
    const exactLearned = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw);
    if (exactLearned !== undefined) return undefined;
    // U12：精确可记忆——建议=本段原文精确规则（不泛化，习得不稀释敏感面）
    return { verdict: "ask", reason: `argv-sensitive:${sensitive.kind}:${sensitive.pattern}`, resolvedBy: "argv-sensitive", memorizable: true, suggestedRule: exactRule(cmd.raw) };
  }
  return undefined;
}

/** full 档短路（U11——维持 PERMISSION-FULL-UNRESTRICTED 现口径）：用户 deny 规则 →
 *  提权/密码类直接 deny → 其余全过 */
function fullDecision(cmd: ParsedCommand, input: BashPipelineInput): BashAdjudication | undefined {
  if (cmd.argv.length === 0) return undefined;
  const denied = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "deny");
  if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  if (hardDeny(cmd.argv) === "sudo" || cmd.ask === "hard-deny:sudo") return { verdict: "deny", reason: "hard-deny:sudo", resolvedBy: "mode:full" };
  return undefined;
}

export function adjudicateBash(input: BashPipelineInput): BashAdjudication {
  if (input.profile.mutationPolicy === "plan-deny") {
    return { verdict: "deny", reason: "plan mode disallows bash", resolvedBy: "mode:plan" };
  }
  const isFull = input.profile.askPolicy === "never" && input.profile.containment === "none";
  const parsed = (input.parse ?? parseBash)(input.command);
  if (!parsed.ok) {
    if (isFull) {
      return ELEVATION_WORD.test(input.command)
        ? { verdict: "deny", reason: "hard-deny:sudo", resolvedBy: "mode:full" }
        : { verdict: "allow", reason: "full mode", resolvedBy: "mode:full" };
    }
    return { verdict: "ask", reason: parsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command", resolvedBy: "parse" };
  }
  const roots = writableRoots(input);
  let sawRuleAllowed = false;
  const clean: ParsedCommand[] = [];
  for (const cmd of parsed.commands) {
    const verdict = isFull ? fullDecision(cmd, input) : commandDecision(cmd, input, roots);
    if (verdict === "rule-allowed") {
      sawRuleAllowed = true; // 段级显式放行（U16——可越过 opaque/敏感面，不进分类器）
      continue;
    }
    if (verdict !== undefined) return verdict;
    clean.push(cmd); // 通过段——习得/不透明/分类器只看这些段（规则放行段不豁免兄弟段）
  }
  if (isFull) return { verdict: "allow", reason: "full mode", resolvedBy: "mode:full" };
  return pipelineTail(input, clean, sawRuleAllowed);
}


/** 管线尾段：显式放行整线 allow → 习得 allow → opaque（on-failure 围栏代问/其余问）→ 分类器三分类 × 档位 */
function pipelineTail(input: BashPipelineInput, clean: readonly ParsedCommand[], sawRuleAllowed: boolean): BashAdjudication {
  // 全部段都被显式规则放行（无剩余通过段）——整线放行（U16 段级终结）
  if (clean.length === 0 && sawRuleAllowed) return { verdict: "allow", reason: "rule allow", resolvedBy: "rule:user" };
  // 习得 allow（grant）：段内敏感面已在 commandDecision 提前返回——习得永不被记忆稀释过线
  for (const cmd of clean) {
    if (cmd.argv.length === 0) continue;
    const learned = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "allow" && rule.nature === "grant");
    if (learned !== undefined) return { verdict: "allow", reason: `grant:${learned.pattern}`, resolvedBy: `grant:${learned.origin}` };
  }
  // 不透明面：on-failure 档围栏代问（contained 不问）；on-opaque/always 问（可记忆）
  for (const cmd of clean) {
    if (cmd.opaque !== undefined) {
      if (input.profile.askPolicy === "on-failure" && input.profile.containment === "fenced") {
        return { verdict: "allow", reason: "classifier:unclassified (fenced)", resolvedBy: "classifier:unclassified" };
      }
      return { verdict: "ask", reason: cmd.opaque, resolvedBy: "opaque", memorizable: true };
    }
  }
  // 分类器（§4.4）：readonly/界内写/未分类 × 档位
  const hasOutputRedirect = clean.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== DEV_NULL));
  const kind = classifyPipeline(clean, hasOutputRedirect, writableRoots(input));
  if (kind === "readonly") return { verdict: "allow", reason: "classifier:readonly", resolvedBy: "classifier:readonly" };
  if (kind === "write") {
    if (input.profile.mutationPolicy === "confirm-all") {
      return { verdict: "ask", reason: "edit-confirm: in-root write", resolvedBy: "edit-confirm", memorizable: true };
    }
    return { verdict: "allow", reason: "classifier:in-root-write", resolvedBy: "classifier:in-root-write" };
  }
  // 未分类：on-failure 围栏代问；其余问（可记忆+建议）
  if (input.profile.askPolicy === "on-failure" && input.profile.containment === "fenced") {
    return { verdict: "allow", reason: "classifier:unclassified (fenced)", resolvedBy: "classifier:unclassified" };
  }
  return { verdict: "ask", reason: "no rule matches segment", resolvedBy: "default:ask", memorizable: true };
}

/** ask 建议规则（决策面统一出口）：可泛化形态给泛化串，其余精确全串 */
export function suggestedRuleOf(command: string, parse?: (src: string) => BashParse): string | undefined {
  const parsed = (parse ?? parseBash)(command);
  if (!parsed.ok) return exactRule(command);
  const generalized = suggestRule(parsed);
  return generalized ?? exactRule(command);
}

export { withinAny };
