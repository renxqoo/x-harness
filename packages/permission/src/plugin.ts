// permission 插件（docs/PERMISSION-V2-DESIGN.md §3/§6）：ask=toolsPreExecute 监听器（dispatch
// 契约零改动——ask = 监听器内 await broker.ask 后返回 allow/deny；broker 缺席 ask 退化 deny）；
// 结构化 ask 往返（记忆梯度+建议规则+escalate 语境）；习得写入三面（session=grants 桶 /
// project|user=grantStore 持久面——NEVER_MEMORIZE 拒记集在 decision.memorizable 收口）；
// 每裁决发审计事件（exec 指令随行）；sessionDisposed 逐出会话桶；拆卸契约：tearing-down 后
// 新 ask 恒 deny、在飞 ask 的迟到裁决丢弃。
// waterfall 语义：必须调 next；deny = next 后返回 deny（最外层 deny 胜）。

import type { Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsPreExecute } from "@x-harness/tools";
import type { PreExecuteDecision, ToolKind } from "@x-harness/tools";
import { decideFor, execOf } from "./decide.ts";
import type { BaselinePolicy } from "./baseline.ts";
import { createModeRegistry, modeRegistry, profileDecideOf, resolveProfileOf } from "./modes.ts";
import type { ModeFaces } from "./modes.ts";
import { summaryOf } from "./ask-summary.ts";
import { suggestedRuleOf } from "./bash/adjudicate.ts";
import type { Decision, DecideInput } from "./decide.ts";
import { GrantsRegistry } from "./grants.ts";
import { parseRules } from "./rules/parse.ts";
import type { ExecDirective, Verdict, PermissionProfile, RuleEntry } from "./types.ts";
import { permissionBroker, permissionDecided, permissionGrantStore, permissionGrantWritten, permissionGrants, permissionMode, fenceFacts } from "./tokens.ts";
import { memoryBlocked } from "./baseline.ts";
import { permissionAdjudicate } from "./tokens.ts";
import type { AskPayload, AskReply, PermissionRule } from "./types.ts";

export interface PermissionOptions {
  readonly root: string;
  /** 档位 id（内置五档或宿主合并自定义行后的 id——开词表）；缺省 auto */
  readonly mode?: string;
  /** 宿主自定义档位行（settings-store profileRowValid 校验——U8 以现状为规格；mergeCustomProfiles 已删） */
  readonly customProfiles?: readonly PermissionProfile[];
  /** 用户作用域规则条目（settings 解析态——origin 由本层补 user） */
  readonly rules?: readonly PermissionRule[];
  /** 项目作用域规则条目（trusted 门禁后由宿主传入——origin 补 project） */
  readonly projectRules?: readonly PermissionRule[];
  /** 受保护路径追加（settings 文件等——Write 工具面 deny + argv 敏感面，U13） */
  readonly protectedPaths?: readonly string[];
  /** 宿主底线覆写（2026-09-29 裁决：内核供机制+缺省值，策略数值宿主定——真有合法越底线
   *  需求如备份凭据目录/受管 .git 写时装配期覆写；信任边界：宿主面专属，模式插件不可及） */
  readonly baseline?: BaselinePolicy;
}

/** 条目作用域补章（settings 解析态无 origin——本层单点盖；session 习得走 grants 桶不经此处） */
/** 记忆规则解析（G/F2/P1-4 守门后）：多规则夹带（;/换行）不落；坏串只批不记（批准语义
 *  不被落账失败反转——tool-bash 同款守门）；习得闸单源（硬拒族/wrapper·解释器头不习得） */
function parseMemoryRule(raw: string | undefined, scope: "session" | "project" | "user"): RuleEntry | undefined {
  if (raw === undefined || raw.includes(";") || raw.includes("\n")) return undefined;
  let parsed: ReturnType<typeof parseRules>;
  try {
    parsed = parseRules([raw], scope);
  } catch {
    return undefined; // 坏规则串静默不落
  }
  const first = parsed[0];
  if (first === undefined || first.verdict !== "allow" || memoryBlocked(first.pattern)) return undefined;
  return { tool: first.tool, pattern: first.pattern, verdict: "allow", nature: "grant", at: Date.now() };
}

/** 执行指令透传尾段：allow + exec 在场 → 附 exec；contained 且模式件声明升级资格 → 附 escalatable
 *  （L5：注册表件与旋钮面同源——自定义 fenced 档经 knob 面同等获得） */
function gateWithExec(downstream: PreExecuteDecision, exec: ExecDirective | undefined, faces: ModeFaces | undefined): PreExecuteDecision {
  if (downstream.kind !== "allow" || exec === undefined) return downstream;
  const escalatable = exec === "contained" && faces?.escalatable === true;
  return { ...downstream, exec, ...(escalatable ? { escalatable: true } : {}) };
}

/** waterfall 载荷 kind（string——类型开放）→ 闭集三分类收窄（dispatch 穿引 ToolDefinition.kind） */
function narrowKind(kind: string | undefined): ToolKind | undefined {
  return kind === "Read" || kind === "Write" || kind === "Danger" ? kind : undefined;
}

function rulesOf(entries: readonly PermissionRule[] | undefined, origin: "user" | "project"): PermissionRule[] {
  return (entries ?? []).map((entry) => ({ ...entry, origin }));
}

/** 档位断代兜底（U3）：解析服务缺席（裸内核）或真未知 id——显式告警 + 落 auto（非静默降级） */
const UNRESOLVED_PROFILE: PermissionProfile = { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" };

export function createPermissionPlugin(options: PermissionOptions): Plugin {
  return {
    name: "permission",
    inject: ["tools"],
    apply: (ctx): Disposer => {
      const protectPattern = (pattern: string): string => {
        if (pattern.includes("*")) return pattern;
        // P-bug-5：裸目录形态补递归通配（否则只护目录自身不护嵌套文件——U13 伪造插件面）
        return pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
      };
      const protectedRules: PermissionRule[] = (options.protectedPaths ?? []).map((pattern) => ({
        tool: "Write" as const,
        pattern: protectPattern(pattern),
        verdict: "deny" as const,
        origin: "default" as const, // P3-11：宿主保护面真归因（不再伪装用户手写）
      }));
      const userRules = [...rulesOf(options.rules, "user"), ...protectedRules];
      const projectRules = rulesOf(options.projectRules, "project");
      const grants = new GrantsRegistry();
      // V4 模式注册表（空开——内置五档在 @x-harness/permission-modes，宿主/策略插件后注册）
      const modes = createModeRegistry();
      let mode: string = options.mode ?? "auto";
      grants.setUnrestricted(modes.resolve(mode)?.unrestricted === true); // 装配期总括授权 → 授权事实（P-mix-7：注册表属性）
      let tearingDown = false;

      // 净化 #5：未知档位显式告警 + 断代落 auto（U3——非静默降级）。告警按 id 去重（M2——
      // 旧实现每裁决两刷）；服务缺席（裸内核）与未知 id 同落 auto
      const warnedModes = new Set<string>();
      const profileOf = (id: string): PermissionProfile => {
        const resolved = ctx.tryUse(resolveProfileOf)?.(id, options.customProfiles);
        if (resolved !== undefined) return resolved;
        if (!warnedModes.has(id)) {
          warnedModes.add(id);
          process.stderr.write(`permission: mode "${id}" unresolvable (profile service absent or unknown id) — falling back to auto (U3 断代)\n`);
        }
        return UNRESOLVED_PROFILE;
      };


      const modeService = {
        get: (): string => mode,
        set(next: string): void {
          mode = next;
          grants.setUnrestricted(modes.resolve(next)?.unrestricted === true); // decide 面与授权面原子同步（P-mix-7）
        },
      };


      /** 习得写入：session→grants 桶；project/user→grantStore（失败不降级写别处） */
      const writeMemory = async (fields: { scope: "session" | "project" | "user"; entry: RuleEntry; session: SessionId | undefined; from: string }): Promise<void> => {
        const { scope, entry, session, from } = fields;
        if (scope === "session") {
          grants.addRule(session, { ...entry, origin: "session" });
        } else {
          const store = ctx.tryUse(permissionGrantStore);
          if (store === undefined) return; // 宿主未提供持久面——选项面已裁剪该作用域
          const written = await store.write(scope, entry);
          if (!written.ok) {
            // 持久写失败降级 session（DESIGN §5.1）——授权不静默丢失
            grants.addRule(session, { ...entry, origin: "session" });
            ctx.emit(permissionGrantWritten, { scope: "session", rule: `${entry.tool}(${entry.pattern}):${entry.verdict}`, from: `${from} (degraded: ${written.reason})` });
            return;
          }
        }
        ctx.emit(permissionGrantWritten, { scope, rule: `${entry.tool}(${entry.pattern}):${entry.verdict}`, from });
      };

      /** 记忆梯度选项：可记忆类四档（无持久面时仅 once/session）；拒记类只余 once */
      const memoryOptionsOf = (decision: Decision): AskPayload["options"] => {
        if (decision.memorizable !== true) return ["once"];
        return ctx.tryUse(permissionGrantStore) !== undefined ? ["once", "session", "project", "user"] : ["once", "session"];
      };

      /** 记忆落账：规则串来源 = 用户改写 > 建议 > 无（不落规则——授权走 extraRoot grant） */
      const settleMemory = async (fields: { reply: AskReply; payload: AskPayload; decision: Decision; session: SessionId | undefined; from: string }): Promise<void> => {
        const { reply, payload, decision, session, from } = fields;
        if (reply.verdict !== "allow" || decision.memorizable !== true) return;
        // G（2026-09-28）：scope 枚举外不落（畸形值不得流向 grant store）
        if (reply.memory !== "session" && reply.memory !== "project" && reply.memory !== "user") return;
        const entry = parseMemoryRule(reply.ruleOverride?.trim() ?? payload.suggestedRule, reply.memory);
        if (entry !== undefined) await writeMemory({ scope: reply.memory, entry, session, from });
      };

      const ask = async (fields: { tool: string; args: unknown; decision: Decision; session: SessionId | undefined; commandOf: () => string; kind?: string }): Promise<"allow" | "deny"> => {
        const { tool, args, decision, session, commandOf, kind } = fields;
        if (tearingDown) return "deny";
        const broker = ctx.tryUse(permissionBroker);
        if (broker === undefined) return "deny"; // broker 缺席 → ask 退化 deny（fail-closed）
        const payload: AskPayload = buildAskPayload({ tool, args, decision, session, commandOf, kind, optionsOf: memoryOptionsOf });
        let reply: AskReply;
        try {
          reply = await broker.ask(payload);
        } catch {
          return "deny"; // broker 抛错 fail-closed
        }
        if (tearingDown) return "deny"; // 在飞 ask 的迟到裁决丢弃（deny 结算语义）
        // P-bug-4a：once 批准不落 root（once≠会话永久）——仅选了记忆档（session/project/user）才落账
        if (reply.verdict === "allow" && reply.memory !== undefined && decision.grant?.kind === "extraRoot") grants.addExtraRoot(session, decision.grant.dir);
        await settleMemory({ reply, payload, decision, session, from: commandOf() });
        return reply.verdict;
      };

      const emitAudit = (fields: { tool: string; verdict: Verdict; resolvedBy: string; reason: string; exec?: ExecDirective; session?: SessionId }): void => {
        ctx.emit(permissionDecided, fields);
      };

      /** decide 入参组装（闭包面：规则集/授权根/围栏事实/保护路径——§3 输入契约单点） */
      // V4 双面解析：注册表 id 命中 > profileDecideOf 服务（permission-modes provide——
      // custom profiles 旋钮承接）> 无（base fail-closed 终态）
      // 面补齐（2026-09-28）：注册表覆盖件缺失的面经旋钮面补——覆盖不得窄于缺省
      //（planMode 丢 posture 修复：富策略只实现 decide，读面姿态继承旋钮缺省档）
      const facesOf = (): ModeFaces | undefined => {
        const plugin = modes.resolve(mode);
        const knob = ctx.tryUse(profileDecideOf)?.(profileOf(mode));
        if (plugin === undefined) return knob;
        return { decide: plugin.decide ?? knob?.decide, posture: plugin.posture ?? knob?.posture, ...(plugin.escalatable === true || knob?.escalatable === true ? { escalatable: true } : {}) };
      };
      const decideInputOf = (payload: { readonly name: string; readonly args: unknown; readonly session?: SessionId; readonly control?: true; readonly kind?: string; readonly readsSubtree?: true }, profile: PermissionProfile): DecideInput => ({
        tool: payload.name,
        args: payload.args,
        ...(narrowKind(payload.kind) !== undefined ? { kind: narrowKind(payload.kind) } : {}),
        ...(payload.readsSubtree === true ? { pathScope: true } : {}),
        session: payload.session,
        userRules,
        ...(projectRules.length > 0 ? { projectRules } : {}),
        sessionRules: grants.rulesOf(payload.session),
        profile,
        root: options.root,
        extraRoots: grants.extraRootsOf(payload.session),
        ...(grants.isUnrestricted(payload.session) ? { unrestricted: true } : {}), // 与授权/围栏面同一总括事实（setUnrestricted 原子同步）
        ...(options.baseline !== undefined ? { baseline: options.baseline } : {}), // 宿主底线覆写（装配期单源）
        ...(ctx.tryUse(fenceFacts) !== undefined ? { fence: ctx.tryUse(fenceFacts)?.forSession(payload.session) } : {}),
        ...(options.protectedPaths !== undefined ? { protectedWrite: options.protectedPaths } : {}),
        ...(() => {
          const faces = facesOf();
          return {
            ...(faces?.decide !== undefined ? { modeDecide: faces.decide } : {}),
            ...(faces?.posture !== undefined ? { postureDecide: faces.posture } : {}),
          };
        })(),
      });

      /** 直调方裁决服务（P0-2 单真相）：与中间件同一 decideInputOf/decideFor——抢救件等
       *  经 tryUse 消费（customProfiles/注册表/底线全内聚），不再各自手抄静态配置面 */
      const adjudicateDirect = (payload: { readonly name: string; readonly args: unknown; readonly session?: SessionId; readonly control?: true; readonly kind?: string }): Decision =>
        decideFor(decideInputOf(payload, profileOf(mode)));
      const offAdjudicate = ctx.provide(permissionAdjudicate, adjudicateDirect);

      const offDecide = ctx.on(toolsPreExecute, async (payload, next): Promise<PreExecuteDecision> => {
        if (payload.control === true) {
          // 控制面工具（isControlTool——dispatch 侧标记）直通：动词本身不触 fs/exec 面
          emitAudit({ tool: payload.name, verdict: "allow", resolvedBy: "control", reason: "control tool", ...(payload.session !== undefined ? { session: payload.session } : {}) });
          return next(payload); // 内核 I2：必须调 next
        }
        const profile = profileOf(mode);
        const decision = decideFor(decideInputOf(payload, profile));
        let finalVerdict = decision.verdict;
        let finalReason = decision.reason;
        if (decision.verdict === "ask") {
          const commandOf = (): string => {
            const args = (payload.args ?? {}) as { command?: unknown };
            return typeof args.command === "string" ? args.command : payload.name;
          };
          const answer = await ask({ tool: payload.name, args: payload.args, decision, session: payload.session, commandOf, kind: payload.kind });
          finalVerdict = answer === "allow" ? "allow" : "deny";
          finalReason = answer === "allow" ? `${decision.reason} (approved)` : decision.reason;
        }
        // 执行指令按终局裁决现算（ask 批准后与即时 allow 同式——对抗审查 #3）
        const exec = finalVerdict === "allow" ? execOf("allow", profile) : undefined;
        emitAudit({
          tool: payload.name,
          verdict: finalVerdict,
          resolvedBy: decision.resolvedBy,
          reason: finalReason,
          ...(exec !== undefined ? { exec } : {}),
          ...(payload.session !== undefined ? { session: payload.session } : {}),
        });
        const downstream = await next(payload); // 内核 I2：必须调 next
        if (finalVerdict === "deny") return { kind: "deny", reason: `permission:${finalReason}` };
        // 执行指令透传（dispatch 管线内服务端独占面——模型入参不可达）；on-failure 档
        // contained 执行带升级资格（工具侧 fenceSuspect 时发起 escalate ask）。
        // L5（2026-09-28）：升级资格注册表/旋钮面同源（自定义 fenced 档经 knob 面同等获得）
        return gateWithExec(downstream, exec, facesOf());
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }) => grants.evict(session));
      const offGrants = ctx.provide(permissionGrants, grants);
      const offMode = ctx.provide(permissionMode, modeService);
      const offModes = ctx.provide(modeRegistry, modes);
      return () => {
        tearingDown = true; // 拒新 ask；在飞 ask 迟到裁决丢弃
        grants.seal();
        offDecide();
        offAdjudicate();
        offDisposed();
        offGrants();
        offMode();
        offModes();
        // 卸载墓碑（红队 F4）：permission 卸载而 tools 存活的窗口留下恒 deny 守卫——
        // 与「从未装配 permission 的裸 SDK 世界」（合法）区分；正常 ctx.dispose 全拆时无害。
        // waterfall 契约（2026-09-29 红队 P1-1）：守卫必须调 next（不调=链断裂报
        // internal:waterfall 错而非设计中的 deny）；deny = next 后返回 deny（最外层胜）。
        // disposer 保留（重装 permission 后旧守卫注销，不再残留击穿）
        let offGuard: (() => void) | undefined;
        try {
          offGuard = ctx.on(toolsPreExecute, async (_payload, next): Promise<PreExecuteDecision> => {
            const inner = await next(_payload);
            if (inner.kind === "allow") return { kind: "deny", reason: "permission: unloaded (guard)" };
            return inner;
          });
        } catch {
          // ctx 已封（全量拆卸路径）——无需守卫
        }
        void offGuard; // 守卫与 permission 同生命周期：ctx 封时链整体拆（重装新链不残留）
      };
    },
  };
}

/** ask 载荷构造（模块级纯函数——参数对象形态避开 max-params）：summary=目标描述（确认条
 *  主文案——确认方一眼可见要动哪个文件/跑哪条命令） */
function buildAskPayload(fields: {
  tool: string;
  args: unknown;
  decision: Decision;
  session: SessionId | undefined;
  commandOf: () => string;
  kind?: string; // waterfall 载荷原串（判别用 === "Danger"）
  optionsOf: (d: Decision) => AskPayload["options"];
}): AskPayload {
  const { tool, args, decision, session, commandOf, kind, optionsOf } = fields;
  const summary = summaryOf(args);
  return {
    tool,
    ...(summary !== undefined ? { summary } : {}),
    reason: decision.reason,
    options: optionsOf(decision),
    // 命令面建议规则经 suggestedRuleOf（命令词面泛化）——判据是 kind 分类非工具名
    //（2026-09-28：非 bash 名的 Danger 工具同获建议——词汇不混入工具名）
    ...(decision.memorizable === true ? { suggestedRule: decision.suggestedRule ?? (kind === "Danger" ? suggestedRuleOf(commandOf()) : undefined) } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}
