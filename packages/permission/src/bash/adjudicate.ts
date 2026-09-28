// bash 裁决管线（docs/PERMISSION-V2-DESIGN.md §3 决策梯）：AST 解析（unparseable/
// parser-unavailable → ask）→ 逐命令 [deny 规则 → 硬拒 ask → injection ask → 结构失败 ask →
// dynamic ask → 重定向双面 → 显式 ask 规则（抑制记忆）→ 显式 allow → argv 敏感面 ask（精确
// 可记忆）→ 习得 allow → opaque → 分类器（readonly/界内写按档/未分类按档）]。
// 拒记集（memorizable=false）：硬拒/injection/结构失败/dynamic/显式 ask 规则——NEVER_MEMORIZE。
// 全档（U11）：硬拒/injection 维持恒 ask 现口径；full 短路维持 PERMISSION-FULL-UNRESTRICTED。
// plan 硬闸（U10）：mutationPolicy=plan-deny 档 Write 无条件 deny，先于一切规则；bash
// 为只读放行策略（2026-09-28 裁决：研究通道重开——planBash，仅分类器 readonly 过）。

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { FenceFacts, PermissionProfile, PermissionRule, Verdict } from "../types.ts";
import { globMatch } from "../rules/glob.ts";
import { bashRuleMatches } from "../rules/bash-prefix.ts";
import { parseBash } from "./ast.ts";
import type { BashParse, ParsedCommand } from "./ast.ts";
import { hardDeny } from "./hard-deny.ts";
import { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE } from "../baseline.ts";
import { argvSensitiveHit } from "../sensitive.ts";
import { suggestRule, exactRule } from "../suggest.ts";
import type { AdjudicationFacts } from "../facts.ts";
import { bashFactsOf } from "../facts.ts";
import type { Decision } from "../decide.ts";

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
  /** V4 模式双面：modeDecide = 短路面（规则引擎前）；postureDecide = 尾段姿态（段梯后） */
  readonly modeDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly postureDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  /** V4 净化 #2：基线拒止规则（permission-modes 产——重定向输入面/敏感面消费其 pattern） */
  readonly denyRules?: readonly PermissionRule[];
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
      const hit = denyReadPatternsOf(input).find((pattern) => globMatch(pattern, path, input.root));
      if (hit !== undefined) return { verdict: "deny", reason: `redirect-read:${hit}`, resolvedBy: "redirect-read" };
      continue;
    }
    // 输出面拒写底线（红队 #1）：纯重定向宿主（argv==0）的 truncate 向量——与输入面拒读同构硬拒
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

/** 单命令裁决：adjudication=管线终止；"rule-allowed"=段被显式规则放行（段级终结——
 *  跳过分类器，其余段照常裁决）；undefined=段通过（进分类器）。 */
function commandDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | { readonly ruleAllowed: PermissionRule } | undefined {
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
  if (allowRule !== undefined) return { ruleAllowed: allowRule };
  // argv 敏感面（U12）：读底线/保护写补偿——强制 ask，精确可记忆；fenced 档交内核执法不问（§4.2 矩阵）
  // 敏感面执法层路由（B-mix-4 再裁决）：围栏在场=内核同表执法（spawn 面拒）——ask 不重复弹；
  // 这是执法 delegation 非判决策略（结论 deny 两路同向）。基线表经入参（净化 #2）
  // P1-3/F2（2026-09-28）：判决面恒执法——旧 fenced 让位读的是档位旋钮非围栏事实，且围栏表
  // 是工具表真子集（无 .env glob）；围栏是执行面冗余，不再是判决面替代
  const sensitive = argvSensitiveHit([cmd], input.root, { protectedWrite: input.protectedWrite ?? [], denyRead: denyReadPatternsOf(input), denyWrite: denyWritePatternsOf(input) });
  if (sensitive !== undefined) {
    // 精确习得豁免：同命令原文的 grant 精确规则放行（U12「精确可记忆」的兑现面——泛化形态不豁免）
    // R3（2026-09-28）：raw 全等旁路——bashPrefixMatch 词元化与 argv 去引号永不一致（引号命令），精确习得按原文比对
    const exactLearned = input.rules.find((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw);
    if (exactLearned !== undefined) return undefined;
    // U12：精确可记忆——建议=本段原文精确规则（不泛化，习得不稀释敏感面）
    return { verdict: "ask", reason: `argv-sensitive:${sensitive.kind}:${sensitive.pattern}`, resolvedBy: "argv-sensitive", memorizable: true, suggestedRule: exactRule(cmd.raw) };
  }
  return undefined;
}

/** 拒止模式提取（C①：底线恒在场 + 调用方追加——敏感面/重定向面消费 pattern；直调/中心装配同源） */
function denyReadPatternsOf(input: BashPipelineInput): readonly string[] {
  return [...DEFAULT_DENY_READ, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Read").map((rule) => rule.pattern)];
}

function denyWritePatternsOf(input: BashPipelineInput): readonly string[] {
  return [...DEFAULT_DENY_WRITE, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Write").map((rule) => rule.pattern)];
}

/** bash 面模式分派（deny 规则已由调用点先行——红线 1；facts 统一经 bashFactsOf 生产——
 *  解析失败面补词面提权兜底（full 档畸形命令的 fail-closed 收敛） */
function bashModeDecision(input: BashPipelineInput): BashAdjudication | undefined {
  const facts = bashFactsOf(input);
  // 词面提权兜底仅在解析失败面（V2 基线同口径——D1 对抗审查处置）
  const enriched = facts.parseFailed !== undefined && ELEVATION_WORD.test(input.command) ? { ...facts, elevation: true as const } : facts;
  const decision = input.modeDecide?.(enriched);
  if (decision === undefined) return undefined;
  if (decision.verdict === "allow") {
    // 红线 2 钳制（2026-09-28 A① 裁决）：硬拒/注入/解析失败事实在场时，模式 allow（full 与
    // 任何第三方模式插件）改写为 ask（拒记）——最小 ask 底线在内核，不依赖插件自觉
    if (facts.hardDenyKind !== undefined || facts.parseFailed !== undefined || (facts.segments ?? []).some((cmd) => cmd.injection !== undefined)) {
      return { verdict: "ask", reason: "hard-deny/injection floor", resolvedBy: "red-line:floor" };
    }
    // B① 敏感底线钳制：argv 实参/重定向目标命中拒读/拒写/保护写 → 精确可记忆 ask（U12
    // 口径）——full/敌意模式不越过；豁免双门：段显式 allow（U16）/ 同命令原文精确习得（U12）
    const floor = sensitiveFloorOf(facts.segments ?? [], input);
    if (floor !== undefined) return floor;
  }
  return adjudicationOf(decision);
}

/** Decision → BashAdjudication 形状归一（模式插件返回核心 Decision 形态——两裁决面共用词表） */
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
  // 模式前置三扫（红线 1 + D① + B①）：deny 规则 → 显式 ask 规则 → 敏感底线——
  // 全部先于模式判决（full/敌意插件不得越过；三面同序 deny → ask → 模式 → allow → posture）
  const preMode = preModeSweep(parsed.commands, input);
  if (preMode !== undefined) return preMode;
  const modeDecision = bashModeDecision(input);
  if (modeDecision !== undefined) return modeDecision;
  const roots = writableRoots(input);
  let sawRuleAllowed: PermissionRule | undefined; // 段级显式放行规则本体（归因真名——P2-5 硬编码消灭）
  const clean: ParsedCommand[] = [];
  for (const cmd of parsed.commands) {
    const verdict = commandDecision(cmd, input, roots);
    if (typeof verdict === "object" && verdict !== null && "ruleAllowed" in verdict) {
      sawRuleAllowed = verdict.ruleAllowed; // 段级显式放行（U16——可越过 opaque/敏感面，不进分类器）
      continue;
    }
    if (verdict !== undefined) return verdict;
    clean.push(cmd); // 通过段——习得/不透明/分类器只看这些段（规则放行段不豁免兄弟段）
  }
  return pipelineTail(input, clean, sawRuleAllowed);
}

/** 管线尾段：显式放行整线 allow → 习得 allow → opaque（on-failure 围栏代问/其余问）→ 分类器三分类 × 档位 */
/** 敏感命中事实（postureFacts 附加形——单次计算） */
function sensitiveFactOf(clean: readonly ParsedCommand[], input: BashPipelineInput): { sensitiveHit?: { readonly kind: string; readonly pattern: string } } {
  const hit = argvSensitiveHit(clean, input.root, { protectedWrite: input.protectedWrite ?? [], denyRead: denyReadPatternsOf(input), denyWrite: denyWritePatternsOf(input) });
  return hit === undefined ? {} : { sensitiveHit: hit };
}

function pipelineTail(input: BashPipelineInput, clean: readonly ParsedCommand[], sawRuleAllowed: PermissionRule | undefined): BashAdjudication {
  // 全部段都被显式规则放行（无剩余通过段）——整线放行（U16 段级终结）
  if (clean.length === 0 && sawRuleAllowed !== undefined) return { verdict: "allow", reason: `rule:${sawRuleAllowed.pattern}`, resolvedBy: `rule:${sawRuleAllowed.origin}` };
  // 习得 allow（grant）：段内敏感面已在 commandDecision 提前返回——习得永不被记忆稀释过线；
  // raw 全等旁路（R3）与 bashPrefixMatch 双门（引号命令词元失配）
  for (const cmd of clean) {
    if (cmd.argv.length === 0) continue;
    const learned = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "allow" && rule.nature === "grant")
      ?? input.rules.find((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw);
    if (learned !== undefined) return { verdict: "allow", reason: `grant:${learned.pattern}`, resolvedBy: `grant:${learned.origin}` };
  }
  // V4 尾段姿态挂点（策略在 permission-modes）：facts 基于通过段重算（opaque 存在性 +
  // 分类三态——与旧梯逐字节等价的判定输入）；opaque ask 是事实面（base 终态），围栏代问
  // 是 sandboxed-auto 姿态（posture 先于 opaque ask 消费同一 facts）
  const hasOutputRedirect = clean.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== DEV_NULL));
  const postureFacts: AdjudicationFacts = {
    face: "bash",
    tool: "bash",
    kind: "Danger",
    segments: clean,
    ...(hasOutputRedirect ? { hasOutputRedirect: true } : {}),
    roots: writableRoots(input),
    root: input.root,
    // B-mix-4 拆解：敏感面事实无条件产出（旧梯 fenced 门已删——P1-3/F2 恒执法）——围栏代问消费归 sandboxed-auto posture
    ...sensitiveFactOf(clean, input),
  };
  const posture = input.postureDecide?.(postureFacts);
  if (posture !== undefined) return adjudicationOf(posture);
  for (const cmd of clean) {
    if (cmd.opaque !== undefined) return { verdict: "ask", reason: cmd.opaque, resolvedBy: "opaque", memorizable: true };
  }
  // base fail-closed 终态：未分类/写类未获姿态 → ask（可记忆+建议）
  return { verdict: "ask", reason: "no rule matches segment", resolvedBy: "default:ask", memorizable: true };
}

/** ask 建议规则（决策面统一出口）：可泛化形态给泛化串，其余精确全串 */
export function suggestedRuleOf(command: string, parse?: (src: string) => BashParse): string | undefined {
  const parsed = (parse ?? parseBash)(command);
  if (!parsed.ok) return exactRule(command);
  const generalized = suggestRule(parsed);
  return generalized ?? exactRule(command);
}

/** 模式前置三扫：deny 规则逐段先行（V3 红线 1）→ 显式 ask 规则（D①——用户「要问」不被档位
 *  整线放行吞）→ 重定向硬线（B①——读 deny/写 deny，含零 argv 纯重定向宿主）。敏感底线在
 *  模式 allow 的钳制位（bashModeDecision）——严格模式的更强判决（如 plan 全拒）不被底线弱化。 */
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

/** 重定向硬线（B①/红队 #1——模式前）：输入面拒读 deny / 输出面拒写 deny（含零 argv 纯
 *  重定向宿主的 truncate 向量）。硬线与段梯 redirectDecision 同表——模式（含 full）不得越过 */
function redirectFloorOf(commands: readonly ParsedCommand[], input: BashPipelineInput): BashAdjudication | undefined {
  for (const cmd of commands) {
    for (const redirect of cmd.redirects) {
      if (redirect.target === undefined || redirect.target === DEV_NULL) continue;
      const path = targetPath(redirect.target, input.root);
      if (path === null) continue;
      const patterns = redirect.face === "input" ? denyReadPatternsOf(input) : denyWritePatternsOf(input);
      const hit = patterns.find((pattern) => globMatch(pattern, path, input.root));
      if (hit !== undefined) {
        return { verdict: "deny", reason: `redirect-${redirect.face === "input" ? "read" : "write"}:${hit}`, resolvedBy: `redirect-${redirect.face === "input" ? "read" : "write"}` };
      }
    }
  }
  return undefined;
}

/** 敏感底线钳制（B①——模式 allow 后）：任一段（含零 argv 纯重定向宿主）的 argv 实参/重定向
 *  目标命中拒读表/拒写表/保护写 → 精确可记忆 ask（U12 口径）。豁免：段显式 allow（U16）/原文精确习得。 */
function sensitiveFloorOf(commands: readonly ParsedCommand[], input: BashPipelineInput): BashAdjudication | undefined {
  const tables = { protectedWrite: input.protectedWrite ?? [], denyRead: denyReadPatternsOf(input), denyWrite: denyWritePatternsOf(input) };
  for (const cmd of commands) {
    const hit = argvSensitiveHit([cmd], input.root, tables);
    if (hit === undefined) continue;
    if (cmd.argv.length > 0) {
      if (bashRuleMatches(input.rules, cmd.argv).some((rule) => rule.verdict === "allow" && rule.nature !== "grant")) continue; // U16：显式权威越过敏感面
      if (input.rules.some((rule) => rule.verdict === "allow" && rule.nature === "grant" && rule.pattern === cmd.raw)) continue; // U12：精确习得豁免
    }
    return { verdict: "ask", reason: `argv-sensitive:${hit.kind}:${hit.pattern}`, resolvedBy: "argv-sensitive", memorizable: true, ...(cmd.argv.length > 0 ? { suggestedRule: exactRule(cmd.raw) } : {}) };
  }
  return undefined;
}

export { withinAny };
