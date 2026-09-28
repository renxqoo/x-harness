// 工具面决策入口（docs/PERMISSION-V2-DESIGN.md §3/§4.2）：read/grep/write/edit 路径面
// （edit 归写族；默认拒读表注入 → deny 压过 allow；界内 auto/confirm；界外
// ask[grant=父目录入 extraRoots]）+ bash 走裁决管线 + 通用 Tool 规则面（任意工具名
// 通配）+ 无专属面工具按档位缺省（full 直通；其余保守 ask）。
// 执行指令 = f(裁决, 档位 containment)：allow → direct|contained；ask/deny 无指令。

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
  /** V4 模式双面（plugin 执行面解析注册表/旋钮后传入；纯函数直调方注入 knobDecideOf）：
   *  modeDecide = 短路面（规则引擎前）；postureDecide = 尾段姿态（规则引擎后） */
  readonly modeDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly postureDecide?: (facts: AdjudicationFacts) => Decision | undefined;
  /** 控制类工具标记（dispatch 从 ToolDefinition.isControlTool 填充）——直通裁决 */
  readonly control?: true;
  /** 工具类别（dispatch 从 ToolDefinition.kind 填充——闭集三分类，与 ToolDefinition
   *  同步）。kind 即工具风险类别：Read=只读 / Write=写 / Danger=行为不可静态分类需
   *  逐次裁决（参数含 command 串）。内核路由：Danger → 命令语言管线；Read/Write →
   *  文件路径面；缺席（业务工具不声明）→ Tool 通配面 fail-closed ask */
  readonly kind?: ToolKind;
  /** path 参数是搜索范围（ToolDefinition.readsSubtree 穿引）：Read 类工具的目录搜索形态——
   *  deny 底线按子树相交判定（无锚拒读模式对目录搜索生效），path 缺席=以 root 为范围 */
  readonly pathScope?: true;
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
  /** 追加拒止规则（2026-09-28 C①：安全底线表已内核化恒合并——本面仅承载调用方追加项；
   *  路径面规则引擎与 bash 面敏感/重定向面消费） */
  readonly denyRules?: readonly PermissionRule[];
  /** 总括授权事实（mode=unrestricted 档——plugin 从注册表解析传入）：拒读底线与
   *  提权外的一切拦截（拒写/灾难形态/注入/解析失败/敏感面 ask）让位放行；纯直调方
   *  缺省 false（各拦截面全量在场） */
  readonly unrestricted?: true;
  /** 宿主底线覆写（BaselinePolicy——缺省内核内置表；传全集即覆写。信任边界：宿主装配
   *  面专属，模式插件不可及） */
  readonly baseline?: BaselinePolicy;
}

/** 执行指令映射（allow → 按档位 containment；ask/deny 无指令）——plugin 批准路径同源复用 */
export function execOf(verdict: Verdict, profile: PermissionProfile): ExecDirective | undefined {
  if (verdict !== "allow") return undefined;
  return profile.containment === "fenced" ? "contained" : "direct";
}

export function decideFor(input: DecideInput): Decision {
  // 控制类工具（agent 自我组织/控制面行为——todo 清单类）：非环境副作用，裁决面直通
  if (input.control === true) return { verdict: "allow", reason: "control tool", resolvedBy: "control-tool" };
  // C①（2026-09-28）：安全底线恒在场（origin "default"——内核数据面，不随模式插件缺席消失）。
  // 拆分（2026-09-28 裁决）：full 语义 = 拒读底线与提权外零拦截——拒写表（.git）仅非总括档合并
  const denyRules = [...baselineDenyRules(input.unrestricted === true, input.baseline), ...(input.denyRules ?? [])];
  const rules = [...(input.projectRules ?? []), ...input.userRules, ...denyRules, ...input.sessionRules];
  if (input.kind === "Danger") return decideDangerFace(input, rules, denyRules);
  if (input.kind === "Read" || input.kind === "Write") {
    // 根归一双轨收敛（P-架构5）+ fence.writable 进路径面（K#9——同档同根两面一致）
    const pathRoots = [resolve(input.root), ...input.extraRoots.map((r) => resolve(input.root, r)), ...(input.fence?.writable ?? []).map((p) => resolve(p))];
    return decidePathTool({ ...input, kind: input.kind, rules, roots: pathRoots });
  }
  return decideToolFace(input, rules);
}

/** Danger 面（命令语言模型）：契约 = 参数含 command 串。缺席/非串 → fail-closed ask
 *  （非命令串的危险工具不声明 Danger——走通用面；方言解析不动 → unparseable ask 同兜底） */
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

/** 通用 Tool 规则面（P2）：deny/ask/allow 显式权威 → 模式分派 → 未分类保守 ask */
function decideToolFace(input: DecideInput, rules: readonly PermissionRule[]): Decision {
  const toolRules = rules.filter((rule) => rule.tool === "Tool" && toolWildcardMatch(rule.pattern, input.tool));
  const denied = toolRules.find((rule) => rule.verdict === "deny");
  if (denied !== undefined) return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  const askRule = toolRules.find((rule) => rule.verdict === "ask" && rule.nature !== "grant");
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  // D①（2026-09-28）：模式短路面位于显式 ask 与显式 allow 之间（三面同序）——
  // 用户「要问」压过模式放行；模式 allow 的归因经 attributeRule 还原命中规则
  const allowed = toolRules.find((rule) => rule.verdict === "allow" && rule.nature !== "grant");
  const modeDecision = input.modeDecide?.({ face: "tool", tool: input.tool, ...(input.kind !== undefined ? { kind: input.kind } : {}) });
  if (modeDecision !== undefined) return withExec(attributeRule(modeDecision, allowed), input.profile);
  if (allowed !== undefined) return allowDecision(`rule:${allowed.pattern}`, `rule:${allowed.origin}`, input.profile);
  // V4：无注入即 base fail-closed 终态（unknown ask）——零内置回退
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
}

function decidePathTool(input: PathDecisionInput): Decision {
  // paths 批量形态（read 多文件）：逐条目裁决后聚合——任一 deny → 整体 deny；任一
  // ask → 整体 ask（首个 ask 胜出，grant/记忆富化随该裁决）；全 allow 才 allow。
  // 逐条目走同一单路径裁决链（deny 清单/模式短路/界外 ask 语义完整继承——批量不绕过任何一面）。
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

/** 单路径裁决（批量与单路径共用主干；批量条目恒在场——absent 恒 false） */
function decideOnePath(input: PathDecisionInput, path: string, absent: boolean): Decision {
  const scope = input.pathScope === true && input.kind === "Read";
  // outsideRoots 条件规则（内核 .env 族底线）：路径在根集内不生效——项目本地配置是常规读写面
  const conditional = (rule: PermissionRule): boolean => rule.outsideRoots === true && withinAny(path, input.roots);
  const denied = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "deny" && path !== "" && !conditional(rule) && (globMatch(rule.pattern, path, input.root) || (scope && scopeDenyAnchored(rule.pattern, path, input.root))));
  if (denied !== undefined) {
    return { verdict: "deny", reason: `rule:${denied.pattern}`, resolvedBy: `rule:${denied.origin}` };
  }

  // 模式短路面（V4：deny 规则先行——红线 1；U7 归因重写见 attributeRule；无注入即继续）
  const inRoot = path !== "" && withinAny(path, input.roots);
  const facts: AdjudicationFacts = { face: "path", tool: input.tool, kind: input.kind, path, inRoot, root: input.root, ...(absent ? { pathAbsent: true } : {}) };
  // D①（2026-09-28）：显式 ask 规则先于模式短路（三面同序 deny → ask → 模式 → allow）
  const askRule = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "ask" && rule.nature !== "grant" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (askRule !== undefined) return { verdict: "ask", reason: `ask-rule:${askRule.pattern}`, resolvedBy: `ask-rule:${askRule.origin}` };
  const shortDecision = input.modeDecide?.(facts);
  if (shortDecision !== undefined) return withExec(attributeRule(shortDecision, allowRuleOf(input, path)), input.profile);
  // allow 终态含习得 grant（归因区分——P-架构4：不再统一伪装 rule:user）
  const allowed = input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "allow" && path !== "" && globMatch(rule.pattern, path, input.root));
  if (allowed !== undefined) return allowDecision(`rule:${allowed.pattern}`, `${allowed.nature === "grant" ? "grant" : "rule"}:${allowed.origin}`, input.profile);
  // R2 无锚底线（范围搜索）：无显式/习得范围 allow 时的一次精确范围 ask——不是全域 deny
  const scopeAsk = scopeDenySoft(input, path, scope);
  if (scopeAsk !== undefined) return scopeAsk;
  // V4 尾段姿态挂点（auto 族：界内放行/edit-confirm 问——策略在 permission-modes）
  const postureDecision = input.postureDecide?.(facts);
  if (postureDecision !== undefined) return withExec(postureDecision, input.profile);
  // V4 净化 #3：界外 ask 的 grant/记忆富化是 auto 族策略——已迁 autoMode.posture；
  // base 终态 = 裸 fail-closed ask（无模式装配即无授权语义）
  return { verdict: "ask", reason: `outside-root:${String(((input.args ?? {}) as { path?: unknown }).path ?? "")}`, resolvedBy: "outside-root" };
}

/** allow 规则命中查找（U7 归因重写用——handwritten 限定） */
function allowRuleOf(input: PathDecisionInput, path: string): PermissionRule | undefined {
  return input.rules.find((rule) => rule.tool === input.kind && rule.verdict === "allow" && rule.nature !== "grant" && path !== "" && globMatch(rule.pattern, path, input.root));
}

/** V4 exec 归一：模式判决的 allow 统一按 profile containment 附加（机制非策略——P-dup-6 单源） */
function withExec(decision: Decision, profile: PermissionProfile): Decision {
  if (decision.verdict !== "allow" || decision.exec !== undefined) return decision;
  const exec = execOf("allow", profile);
  return exec === undefined ? decision : { ...decision, exec };
}

/** path 归一（净化 #6）：缺席/非串 → root + pathAbsent 事实标记——模式可据其改判
 *  （P-mix-13 隐藏 fail-open 废除：异名 path 字段的工具不再静默按界内放行） */
function pathOf(input: PathDecisionInput): { readonly path: string; readonly absent: boolean } {
  const args = (input.args ?? {}) as { path?: unknown };
  // K#7（2026-09-28）：空串与缺席同判 absent（旧：resolve(root,"")=root → 界内 allow 的假象）。
  // R8：范围型读工具（pathScope）缺席 = 以 root 为范围的合法搜索（工具缺省形态，非缺参错误）
  if (typeof args.path === "string" && args.path !== "") return { path: resolve(input.root, args.path), absent: false };
  return input.pathScope === true ? { path: resolve(input.root), absent: false } : { path: input.root, absent: true };
}

/** paths 批量条目归一（read 多文件形态）；非数组/空 → undefined 走单路径链 */
function pathsOf(input: PathDecisionInput): readonly { readonly path: string }[] | undefined {
  const args = (input.args ?? {}) as { paths?: unknown };
  if (!Array.isArray(args.paths) || args.paths.length === 0) return undefined;
  const entries: { path: string }[] = [];
  for (const item of args.paths) {
    if (typeof item !== "string") continue; // 垃圾条目跳过——schema 层已拒，防御双保险
    entries.push({ path: resolve(input.root, item) });
  }
  return entries.length > 0 ? entries : undefined;
}

/** R2 无锚底线 ask 位：无目录锚的拒读模式对目录搜索恒可能命中——一次精确范围 ask
 *  （memorizable + Read(范围) 建议——习得后同范围免问），不做全域 deny（grep 不废） */
function scopeDenySoft(input: PathDecisionInput, path: string, scope: boolean): Decision | undefined {
  if (!scope) return undefined;
  // outsideRoots 条件规则（.env 族）：搜索范围在根集内时无「可能命中」——不触发范围 ask
  const unanchored = input.rules.find((rule) => rule.tool === "Read" && rule.verdict === "deny" && !(rule.outsideRoots === true && withinAny(path, input.roots)) && unanchoredPattern(rule.pattern));
  return unanchored === undefined ? undefined : { verdict: "ask", reason: `scope-deny:${unanchored.pattern}`, resolvedBy: "scope-deny", memorizable: true, suggestedRule: `Read(${path}):allow` };
}

/** 无锚模式判定：首个 * 前无目录基（双星斜杠开头类无锚拒读模式）——对任意范围搜索恒可能命中 */
function unanchoredPattern(pattern: string): boolean {
  const star = pattern.indexOf("*");
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const base = head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
  return base === "" || base === "~";
}

/** 有锚子树相交（R2 硬拒位）：模式的字面目录基与搜索范围两目录区间相交——
 *  `~/.ssh/**` 对搜索 ~ 生效（范围覆盖被拒目录）。无锚模式不经此位（走 ask 位） */
function scopeDenyAnchored(pattern: string, scope: string, root: string): boolean {
  if (unanchoredPattern(pattern)) return false;
  const star = pattern.indexOf("*");
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const base = head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
  const dir = basedirOf(base, root);
  const within = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
  return within(dir, scope) || within(scope, dir);
}

/** 模式目录基归一（~ 展开 + root 相对解析） */
function basedirOf(base: string, root: string): string {
  if (base === "~") return homedir();
  if (base.startsWith("~/")) return resolve(homedir(), base.slice(2));
  return resolve(root, base);
}

/** U7 归因重写：模式插件判 allow 且存在显式 allow 规则命中 → 归因改写为规则（full 短路
 *  不再吞掉规则归因——审计史更真；其余判决原样透传） */
function attributeRule(modeDecision: Decision, allowRule: PermissionRule | undefined): Decision {
  if (modeDecision.verdict !== "allow" || allowRule === undefined) return modeDecision;
  return { ...modeDecision, reason: `rule:${allowRule.pattern}`, resolvedBy: `rule:${allowRule.origin}` };
}



function allowDecision(reason: string, resolvedBy: string, profile: PermissionProfile): Decision {
  const exec = execOf("allow", profile);
  return { verdict: "allow", reason, resolvedBy, ...(exec !== undefined ? { exec } : {}) };
}
