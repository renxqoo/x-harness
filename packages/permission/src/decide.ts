// 工具面决策入口（docs/PERMISSION-V2-DESIGN.md §3/§4.2）：read/grep/write 路径面（默认拒读
// 表注入 → deny 压过 allow；界内 auto/confirm；界外 ask[grant=父目录入 extraRoots]）+
// bash 走裁决管线 + 通用 Tool 规则面（任意工具名通配）+ 未知工具保守 ask。
// 执行指令 = f(裁决, 档位 containment)：allow → direct|contained；ask/deny 无指令。

import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { ExecDirective, FenceFacts, PermissionProfile, PermissionRule, Verdict } from "./types.ts";
import { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE } from "./types.ts";
import { globMatch } from "./rules/glob.ts";
import { adjudicateBash, withinAny } from "./bash/adjudicate.ts";

export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
  /** allow 的执行指令（containment=fenced → contained；none → direct）；ask/deny 缺席 */
  readonly exec?: ExecDirective;
  /** ask 批准时的落账动作提示（plugin 据此记 grants——路径工具界外授权） */
  readonly grant?: { readonly kind: "extraRoot"; readonly dir: string };
  /** 可记忆（ask 类）：true=四档记忆选项可用；缺省=拒记（NEVER_MEMORIZE 拒记集） */
  readonly memorizable?: true;
  /** 记忆建议规则串（精确兜底；泛化边界在 adjudicate/suggest 层约束） */
  readonly suggestedRule?: string;
}

export interface DecideInput {
  readonly tool: string;
  readonly args: unknown;
  /** 控制类工具标记（dispatch 从 ToolDefinition.isControlTool 填充）——直通裁决 */
  readonly control?: true;
  readonly session?: SessionId;
  /** 用户作用域规则（user settings 解析——handwritten+grant 混装，origin=user） */
  readonly userRules: readonly PermissionRule[];
  /** 项目作用域规则（project settings 解析——trusted 门禁后的装配快照） */
  readonly projectRules?: readonly PermissionRule[];
  /** 会话授权桶规则（习得 session 记忆——origin=session） */
  readonly sessionRules: readonly PermissionRule[];
  readonly profile: PermissionProfile;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
  /** 宿主保护写路径（argv 敏感面 + 路径工具 deny 面，U13） */
  readonly protectedWrite?: readonly string[];
}

function defaultDenyRules(): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const pattern of DEFAULT_DENY_READ) {
    rules.push({ tool: "Read", pattern, verdict: "deny", origin: "user" });
    rules.push({ tool: "Grep", pattern, verdict: "deny", origin: "user" });
  }
  for (const pattern of DEFAULT_DENY_WRITE) rules.push({ tool: "Write", pattern, verdict: "deny", origin: "user" });
  return rules;
}

/** 执行指令映射（allow → 按档位 containment；ask/deny 无指令）——plugin 批准路径同源复用 */
export function execOf(verdict: Verdict, profile: PermissionProfile): ExecDirective | undefined {
  if (verdict !== "allow") return undefined;
  return profile.containment === "fenced" ? "contained" : "direct";
}

export function decideFor(input: DecideInput): Decision {
  // 控制类工具（agent 自我组织/控制面行为——todo 清单类）：非环境副作用，裁决面直通
  if (input.control === true) return { verdict: "allow", reason: "control tool", resolvedBy: "control-tool" };
  const rules = [...(input.projectRules ?? []), ...input.userRules, ...defaultDenyRules(), ...input.sessionRules];
  const pathRoots = [input.root, ...input.extraRoots.map((r) => resolve(r))];
  if (input.tool === "bash") {
    const args = (input.args ?? {}) as { command?: unknown };
    const adjudication = adjudicateBash({
      command: typeof args.command === "string" ? args.command : "",
      rules,
      profile: input.profile,
      root: input.root,
      extraRoots: input.extraRoots,
      fence: input.fence,
      ...(input.protectedWrite !== undefined ? { protectedWrite: input.protectedWrite } : {}),
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
  const ruleTool = ruleToolOf(input.tool);
  if (ruleTool === undefined) {
    // 通用 Tool 规则面（P2——任意工具名通配匹配）：显式权威先于保守 ask
    const toolRules = rules.filter((rule) => rule.tool === "Tool" && toolWildcardMatch(rule.pattern, input.tool));
    const denied = toolRules.find((rule) => rule.verdict === "deny");
    if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
    const allowed = toolRules.find((rule) => rule.verdict === "allow");
    if (allowed !== undefined) return { verdict: "allow", reason: `rule:${allowed.pattern}`, resolvedBy: `rule:${allowed.origin}` };
    return { verdict: "ask", reason: `unknown tool:${input.tool}`, resolvedBy: "default:ask", memorizable: true };
  }
  return decidePathTool({ ...input, ruleTool, rules, roots: pathRoots });
}

function toolWildcardMatch(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === tool;
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return regex.test(tool);
}

function ruleToolOf(tool: string): "Read" | "Write" | "Grep" | undefined {
  if (tool === "read") return "Read";
  if (tool === "write") return "Write";
  if (tool === "grep") return "Grep";
  return undefined;
}

interface PathDecisionInput extends DecideInput {
  readonly ruleTool: "Read" | "Write" | "Grep";
  readonly rules: readonly PermissionRule[];
  readonly roots: readonly string[];
}

function decidePathTool(input: PathDecisionInput): Decision {
  const path = pathOf(input);
  const denied = input.rules.find((rule) => rule.tool === input.ruleTool && rule.verdict === "deny" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (denied !== undefined) {
    return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  }
  if (planWriteGate(input)) {
    return { verdict: "deny", reason: "plan mode disallows write", resolvedBy: "mode:plan" };
  }
  if (isFullProfile(input.profile)) {
    return { verdict: "allow", reason: "full mode", resolvedBy: "mode:full", exec: "direct" };
  }
  if (ruleAllowsPath(input, path)) return allowDecision("rule allow", "rule:user", input.profile);
  if (path !== "" && withinAny(path, input.roots)) {
    if (confirmAllWrite(input)) return { verdict: "ask", reason: "edit-confirm: in-root write", resolvedBy: "edit-confirm", memorizable: true, suggestedRule: `Write(${input.root}/**)` };
    return allowDecision("in-root", "auto", input.profile);
  }
  // 界外：ask——批准落账目标父目录（会话语义）+ 可记忆
  const dir = path === "" ? input.root : path.slice(0, Math.max(path.lastIndexOf("/"), 1));
  return { verdict: "ask", reason: `outside-root:${String(((input.args ?? {}) as { path?: unknown }).path ?? "")}`, resolvedBy: "outside-root", grant: { kind: "extraRoot", dir }, memorizable: true };
}

/** path 归一：缺省=工作区根（镜像 toolbox grep 的 schema 缺省——不因缺参坠落 ask） */
function pathOf(input: PathDecisionInput): string {
  const args = (input.args ?? {}) as { path?: unknown };
  return typeof args.path === "string" ? resolve(input.root, args.path) : input.root;
}

/** plan 硬闸（U10）：Write 族无条件 deny，先于 allow 规则 */
function planWriteGate(input: PathDecisionInput): boolean {
  return input.profile.mutationPolicy === "plan-deny" && input.ruleTool === "Write";
}

/** full 短路口径（与 bash 管线 isFull 同式——askPolicy never + 直通） */
function isFullProfile(profile: { readonly askPolicy: string; readonly containment: string }): boolean {
  return profile.askPolicy === "never" && profile.containment === "none";
}

function ruleAllowsPath(input: PathDecisionInput, path: string): boolean {
  return input.rules.some((rule) => rule.tool === input.ruleTool && rule.verdict === "allow" && path !== "" && globMatch(rule.pattern, path, input.root));
}

/** 界内写在 confirm-all 档问（edit-confirm）；读类不受此闸 */
function confirmAllWrite(input: PathDecisionInput): boolean {
  return input.ruleTool === "Write" && input.profile.mutationPolicy === "confirm-all";
}

function allowDecision(reason: string, resolvedBy: string, profile: PermissionProfile): Decision {
  const exec = execOf("allow", profile);
  return { verdict: "allow", reason, resolvedBy, ...(exec !== undefined ? { exec } : {}) };
}
