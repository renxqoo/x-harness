// 工具面决策入口（docs/EXEC-ENV.md §5/§6）：read/grep/write 路径面（默认拒读表 user-origin deny
// 注入 → deny 压过 allow；界内 auto；界外 ask[grant=父目录入 extraRoots]）+ bash 走裁决管线 +
// 未知工具保守 ask。full 档=全 allow 除 deny 规则与硬拒底线。

import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { FenceFacts, ModeKnob, PermissionRule, Verdict } from "./types.ts";
import { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE } from "./types.ts";
import { globMatch } from "./rules/glob.ts";
import { adjudicateBash, withinAny } from "./bash/adjudicate.ts";

export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly resolvedBy: string;
  /** ask 批准时的落账动作提示（plugin 据此记 grants） */
  readonly grant?: { readonly kind: "extraRoot"; readonly dir: string };
}

export interface DecideInput {
  readonly tool: string;
  readonly args: unknown;
  readonly session?: SessionId;
  readonly userRules: readonly PermissionRule[];
  readonly sessionRules: readonly PermissionRule[];
  readonly mode: ModeKnob;
  readonly root: string;
  readonly extraRoots: readonly string[];
  readonly fence?: FenceFacts;
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

export function decideFor(input: DecideInput): Decision {
  const rules = [...input.userRules, ...defaultDenyRules(), ...input.sessionRules];
  // 路径面（read/write/grep）界内判定 = gate 语义（root ∪ 会话授权根）——不含 fence.writable
  // （那是 bash/spawn 面的可写集，含 tmpdir；两层口径漂移会把 tmpdir 误判为工具面界内）
  const pathRoots = [input.root, ...input.extraRoots.map((r) => resolve(r))];
  if (input.tool === "bash") {
    const args = (input.args ?? {}) as { command?: unknown };
    const adjudication = adjudicateBash({
      command: typeof args.command === "string" ? args.command : "",
      rules,
      mode: input.mode,
      root: input.root,
      extraRoots: input.extraRoots,
      fence: input.fence,
    });
    return adjudication;
  }
  const ruleTool = ruleToolOf(input.tool);
  if (ruleTool === undefined) {
    return { verdict: "ask", reason: `unknown tool:${input.tool}`, resolvedBy: "default:ask" };
  }
  return decidePathTool({ ...input, ruleTool, rules, roots: pathRoots });
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
  const args = (input.args ?? {}) as { path?: unknown };
  // path 缺省=工作区根（镜像 toolbox grep 的 schema 缺省——不因缺参坠落 ask）
  const path = typeof args.path === "string" ? resolve(input.root, args.path) : input.root;
  const denied = input.rules.find((rule) => rule.tool === input.ruleTool && rule.verdict === "deny" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (denied !== undefined) {
    return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  }
  if (input.mode === "plan" && input.ruleTool === "Write") {
    return { verdict: "deny", reason: "plan mode disallows write", resolvedBy: "mode:plan" };
  }
  if (input.mode === "full") {
    return { verdict: "allow", reason: "full mode", resolvedBy: "mode:full" };
  }
  if (path !== "" && withinAny(path, input.roots)) {
    return { verdict: "allow", reason: "in-root", resolvedBy: "auto" };
  }
  const allowed = input.rules.some((rule) => rule.tool === input.ruleTool && rule.verdict === "allow" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (allowed) return { verdict: "allow", reason: "rule allow", resolvedBy: "rule:user" };
  // 界外：ask——批准落账目标父目录（Claude additionalDirectories 会话语义）
  const dir = path === "" ? input.root : path.slice(0, Math.max(path.lastIndexOf("/"), 1));
  return { verdict: "ask", reason: `outside-root:${args.path ?? ""}`, resolvedBy: "outside-root", grant: { kind: "extraRoot", dir } };
}
