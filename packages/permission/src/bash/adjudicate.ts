// bash 裁决管线（docs/EXEC-ENV.md §5/§14）：AST 解析（unparseable/parser-unavailable → ask）→
// 逐命令 [deny 规则 → 硬拒 ask → injection ask → 结构失败 ask → dynamic(auto:ask/full:过) →
// 重定向双面 → allow 规则 → 不透明 ask → full 过 → 界内合成(auto:allow) → 默认 ask] →
// 全命令允许后 needs_network → ask。deny 压过 allow；硬拒/injection/结构失败恒 ask
// （allow 规则不可越过——NEVER_MEMORIZE）；不透明面（source/解释器文件/字符串实参代码）可被
// allow 规则以用户信任越过。裁决序重排申明见 §14.4：deny 规则现压过 injection（确定性拒绝
// 先于保守 ask，与 full 档 deny 压过硬拒同哲学）。

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { FenceFacts, ModeKnob, PermissionRule, Verdict } from "../types.ts";
import { DEFAULT_DENY_READ } from "../types.ts";
import { globMatch } from "../rules/glob.ts";
import { bashRuleMatches } from "../rules/bash-prefix.ts";
import { parseBash } from "./ast.ts";
import type { BashParse, ParsedCommand } from "./ast.ts";
import { hardDeny } from "./hard-deny.ts";

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
  /** 解析器接缝（缺省真 parseBash）——parser-unavailable 裁决级 reason 的测试锚 */
  readonly parse?: (src: string) => BashParse;
}

export function writableRoots(input: { readonly root: string; readonly extraRoots: readonly string[]; readonly fence?: FenceFacts }): string[] {
  return [input.root, ...input.extraRoots, ...(input.fence?.writable ?? [])].map((p) => resolve(p));
}

/** 路径段边界前缀判定（防 /w/app vs /w/appdir 混淆） */
export function withinAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}

export const DEV_NULL = "/dev/null";

/** 重定向目标归一：~ 与 ~/ 展开 + root 相对解析；~user 形不可静态解析（node 无 passwd 面）→ null */
function targetPath(target: string, root: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (/^~[A-Za-z0-9_.-]/.test(target)) return null; // ~root/pwn 类——保守 ask
  return resolve(root, target);
}

/** 重定向双面裁决（§14.2 边界 2）：输出面越根/目标不可解析 → ask；输入面命中拒读表 → deny
 *  （不做越根 ask——argv 文件实参同不做根裁决，口径一致；敏感读面的闸门是 denyRead 双层同表执法）。 */
function redirectDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | undefined {
  for (const redirect of cmd.redirects) {
    if (redirect.target === undefined || redirect.target === DEV_NULL) continue; // fd 复制/heredoc 无文件目标；/dev/null 围栏许可
    const path = targetPath(redirect.target, input.root);
    if (path === null) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect" }; // ~user 形不可解析
    if (redirect.face === "input") {
      const hit = DEFAULT_DENY_READ.find((pattern) => globMatch(pattern, path, input.root));
      if (hit !== undefined) return { verdict: "deny", reason: `redirect-read:${hit}`, resolvedBy: "redirect-read" };
      continue;
    }
    if (!withinAny(path, roots)) return { verdict: "ask", reason: `redirect:${redirect.target}`, resolvedBy: "redirect" };
  }
  return undefined;
}

/** 单命令裁决：返回 adjudication = 管线在此终止；undefined = 命令通过（继续） */
function commandDecision(cmd: ParsedCommand, input: BashPipelineInput, roots: readonly string[]): BashAdjudication | undefined {
  if (cmd.argv.length > 0) {
    const denied = bashRuleMatches(input.rules, cmd.argv).find((rule) => rule.verdict === "deny");
    if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
    const hard = hardDeny(cmd.argv);
    if (hard !== undefined) return { verdict: "ask", reason: `hard-deny:${hard}`, resolvedBy: "hard-deny" };
  }
  if (cmd.injection !== undefined) return { verdict: "ask", reason: `injection:${cmd.injection}`, resolvedBy: "injection" };
  if (cmd.ask !== undefined) return { verdict: "ask", reason: cmd.ask, resolvedBy: "wrapper" };
  if (cmd.dynamic && input.mode !== "full") {
    return { verdict: "ask", reason: "dynamic-segment (expansion/glob)", resolvedBy: "static" }; // 静态不可裁决
  }
  // full 档 dynamic 落穿到重定向裁决（目标越根/拒读表仍拦——围栏之外的第二道；无围栏 full 不得裸放）
  if (cmd.argv.length === 0) return redirectDecision(cmd, input, roots); // 纯重定向宿主——只裁 redirects
  const blocked = redirectDecision(cmd, input, roots);
  if (blocked !== undefined) return blocked;
  const allowed = bashRuleMatches(input.rules, cmd.argv).some((rule) => rule.verdict === "allow");
  if (allowed) return undefined;
  if (cmd.opaque !== undefined) return { verdict: "ask", reason: cmd.opaque, resolvedBy: "opaque" };
  if (input.mode === "full") return undefined;
  // 界内合成（§5 步 5）：围栏在场 + 命令静态（非 dynamic）+ 重定向已全在界内 → auto-allow 零交互；
  // 无围栏装配时永不界内 auto（§6 对照句——bash 缺省 ask/deny）
  if (input.fence !== undefined) return undefined;
  return { verdict: "ask", reason: "no rule matches segment", resolvedBy: "default:ask" };
}

export function adjudicateBash(input: BashPipelineInput): BashAdjudication {
  if (input.mode === "plan") return { verdict: "deny", reason: "plan mode disallows bash", resolvedBy: "mode:plan" };
  const parsed = (input.parse ?? parseBash)(input.command);
  if (!parsed.ok) {
    return { verdict: "ask", reason: parsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command", resolvedBy: "parse" };
  }
  const roots = writableRoots(input);
  for (const cmd of parsed.commands) {
    const blocked = commandDecision(cmd, input, roots);
    if (blocked !== undefined) return blocked;
  }
  if (input.needsNetwork === true) return { verdict: "ask", reason: "network", resolvedBy: "needs_network" };
  return { verdict: "allow", reason: "in-fence", resolvedBy: input.fence !== undefined ? "auto:fence" : "auto" };
}
