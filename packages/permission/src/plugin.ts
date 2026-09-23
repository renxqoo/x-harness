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
import type { PreExecuteDecision } from "@x-harness/tools";
import { decideFor, execOf } from "./decide.ts";
import { suggestedRuleOf } from "./bash/adjudicate.ts";
import type { Decision, DecideInput } from "./decide.ts";
import { GrantsRegistry } from "./grants.ts";
import { parseRules } from "./rules/parse.ts";
import { resolveProfile } from "./profiles.ts";
import type { ExecDirective, Verdict,  PermissionProfile, ProfileId, RuleEntry } from "./types.ts";
import { permissionBroker, permissionDecided, permissionGrantStore, permissionGrantWritten, permissionGrants, permissionMode, fenceFacts } from "./tokens.ts";
import type { AskPayload, AskReply, PermissionRule } from "./types.ts";

export interface PermissionOptions {
  readonly root: string;
  /** 档位 id（内置五档或宿主合并自定义行后的 id）；缺省 auto */
  readonly mode?: ProfileId;
  /** 宿主自定义档位行（已过 mergeCustomProfiles 校验——装载期 fail-fast 在宿主） */
  readonly customProfiles?: readonly PermissionProfile[];
  /** 用户作用域规则条目（settings 解析态——origin 由本层补 user） */
  readonly rules?: readonly PermissionRule[];
  /** 项目作用域规则条目（trusted 门禁后由宿主传入——origin 补 project） */
  readonly projectRules?: readonly PermissionRule[];
  /** 受保护路径追加（settings 文件等——Write 工具面 deny + argv 敏感面，U13） */
  readonly protectedPaths?: readonly string[];
}

/** 条目作用域补章（settings 解析态无 origin——本层单点盖；session 习得走 grants 桶不经此处） */
function rulesOf(entries: readonly PermissionRule[] | undefined, origin: "user" | "project"): PermissionRule[] {
  return (entries ?? []).map((entry) => ({ ...entry, origin }));
}

export function createPermissionPlugin(options: PermissionOptions): Plugin {
  return {
    name: "permission",
    inject: ["tools"],
    apply: (ctx): Disposer => {
      const protectedRules: PermissionRule[] = (options.protectedPaths ?? []).map((pattern) => ({
        tool: "Write" as const,
        pattern,
        verdict: "deny" as const,
        origin: "user" as const,
      }));
      const userRules = [...rulesOf(options.rules, "user"), ...protectedRules];
      const projectRules = rulesOf(options.projectRules, "project");
      const grants = new GrantsRegistry();
      let mode: ProfileId = options.mode ?? "auto";
      grants.setUnrestricted(mode === "full"); // 装配期总括授权 → 授权事实（docs/PERMISSION-FULL-UNRESTRICTED.md）
      let tearingDown = false;

      const profileOf = (id: ProfileId): PermissionProfile => resolveProfile(id, options.customProfiles);

      const modeService = {
        get: (): ProfileId => mode,
        set(next: ProfileId): void {
          mode = next;
          grants.setUnrestricted(next === "full"); // decide 面与授权面原子同步
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
        if (reply.verdict !== "allow" || reply.memory === undefined || decision.memorizable !== true) return;
        const raw = reply.ruleOverride?.trim() ?? payload.suggestedRule;
        if (raw === undefined) return;
        const parsed = parseRules([raw], reply.memory === "session" ? "session" : reply.memory);
        const first = parsed[0];
        if (first !== undefined && first.verdict === "allow") {
          await writeMemory({ scope: reply.memory, entry: { tool: first.tool, pattern: first.pattern, verdict: "allow", nature: "grant", at: Date.now() }, session, from });
        }
      };

      const ask = async (fields: { tool: string; decision: Decision; session: SessionId | undefined; commandOf: () => string }): Promise<"allow" | "deny"> => {
        const { tool, decision, session, commandOf } = fields;
        if (tearingDown) return "deny";
        const broker = ctx.tryUse(permissionBroker);
        if (broker === undefined) return "deny"; // broker 缺席 → ask 退化 deny（fail-closed）
        const payload: AskPayload = buildAskPayload({ tool, decision, session, commandOf, optionsOf: memoryOptionsOf });
        let reply: AskReply;
        try {
          reply = await broker.ask(payload);
        } catch {
          return "deny"; // broker 抛错 fail-closed
        }
        if (tearingDown) return "deny"; // 在飞 ask 的迟到裁决丢弃（deny 结算语义）
        if (reply.verdict === "allow" && decision.grant?.kind === "extraRoot") grants.addExtraRoot(session, decision.grant.dir);
        await settleMemory({ reply, payload, decision, session, from: commandOf() });
        return reply.verdict;
      };

      const emitAudit = (fields: { tool: string; verdict: Verdict; resolvedBy: string; reason: string; exec?: ExecDirective; session?: SessionId }): void => {
        ctx.emit(permissionDecided, fields);
      };

      /** decide 入参组装（闭包面：规则集/授权根/围栏事实/保护路径——§3 输入契约单点） */
      const decideInputOf = (payload: { readonly name: string; readonly args: unknown; readonly session?: SessionId }, profile: PermissionProfile): DecideInput => ({
        tool: payload.name,
        args: payload.args,
        session: payload.session,
        userRules,
        ...(projectRules.length > 0 ? { projectRules } : {}),
        sessionRules: grants.rulesOf(payload.session),
        profile,
        root: options.root,
        extraRoots: grants.extraRootsOf(payload.session),
        ...(ctx.tryUse(fenceFacts) !== undefined ? { fence: ctx.tryUse(fenceFacts)?.forSession(payload.session) } : {}),
        ...(options.protectedPaths !== undefined ? { protectedWrite: options.protectedPaths } : {}),
      });

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
          const answer = await ask({ tool: payload.name, decision, session: payload.session, commandOf });
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
        // contained 执行带升级资格（工具侧 fenceSuspect 时发起 escalate ask）
        if (downstream.kind === "allow" && exec !== undefined) {
          const escalatable = exec === "contained" && profile.askPolicy === "on-failure";
          return { ...downstream, exec, ...(escalatable ? { escalatable: true } : {}) };
        }
        return downstream;
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }) => grants.evict(session));
      const offGrants = ctx.provide(permissionGrants, grants);
      const offMode = ctx.provide(permissionMode, modeService);
      return () => {
        tearingDown = true; // 拒新 ask；在飞 ask 迟到裁决丢弃
        grants.seal();
        offDecide();
        offDisposed();
        offGrants();
        offMode();
      };
    },
  };
}

/** ask 载荷构造（模块级纯函数——参数对象形态避开 max-params） */
function buildAskPayload(fields: {
  tool: string;
  decision: Decision;
  session: SessionId | undefined;
  commandOf: () => string;
  optionsOf: (d: Decision) => AskPayload["options"];
}): AskPayload {
  const { tool, decision, session, commandOf, optionsOf } = fields;
  return {
    tool,
    reason: decision.reason,
    options: optionsOf(decision),
    ...(decision.memorizable === true && tool === "bash" ? { suggestedRule: decision.suggestedRule ?? suggestedRuleOf(commandOf()) } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}
