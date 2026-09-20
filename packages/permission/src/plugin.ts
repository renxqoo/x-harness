// permission 插件（docs/EXEC-ENV.md §5/§6）：ask 内嵌 toolsPreExecute 监听器（dispatch 契约零改动——
// ask = 监听器内 await broker.ask 后返回 allow/deny；broker 缺席 ask 退化 deny）；每裁决发审计事件；
// sessionDisposed 逐出会话桶；拆卸契约：tearing-down 后新 ask 恒 deny、在飞 ask 的迟到裁决丢弃。
// waterfall 语义：必须调 next；deny = next 后返回 deny（最外层 deny 胜）。
// 会话事实来自 dispatch 服务端透传的 payload.session（tools 契约字段）——模型入参不可伪造。

import type { Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsPreExecute } from "@x-harness/tools";
import type { PreExecuteDecision } from "@x-harness/tools";
import { decideFor } from "./decide.ts";
import type { Decision } from "./decide.ts";
import { GrantsRegistry } from "./grants.ts";
import { parseRules } from "./rules/parse.ts";
import { permissionBroker, permissionDecided, permissionGrants, fenceFacts } from "./tokens.ts";
import type { ModeKnob, PermissionRule } from "./types.ts";

export interface PermissionOptions {
  readonly root: string;
  readonly mode?: ModeKnob;
  /** 规则字符串（`Bash(git status):allow` 形态）；拼错 fail-closed 拒启 */
  readonly rules?: readonly string[];
  /** 受保护路径追加（默认 .git 内部写拒之外宿主加护的路径） */
  readonly protectedPaths?: readonly string[];
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
      const userRules = [...parseRules(options.rules ?? [], "user"), ...protectedRules];
      const grants = new GrantsRegistry();
      const mode = options.mode ?? "auto";
      if (mode === "full") grants.setUnrestricted(); // 启动期总括授权 → 授权事实（docs/PERMISSION-FULL-UNRESTRICTED.md）
      let tearingDown = false;

      const ask = async (tool: string, decision: Decision, session: SessionId | undefined): Promise<"allow" | "deny"> => {
        if (tearingDown) return "deny";
        const broker = ctx.tryUse(permissionBroker);
        if (broker === undefined) return "deny"; // broker 缺席 → ask 退化 deny（fail-closed）
        let verdict: "allow" | "deny";
        try {
          verdict = await broker.ask({ tool, reason: decision.reason, ...(session !== undefined ? { session } : {}) });
        } catch {
          return "deny"; // broker 抛错 fail-closed
        }
        if (tearingDown) return "deny"; // 在飞 ask 的迟到裁决丢弃（deny 结算语义）
        if (verdict === "allow" && decision.grant?.kind === "extraRoot") grants.addExtraRoot(session, decision.grant.dir);
        return verdict;
      };

      const offDecide = ctx.on(toolsPreExecute, async (payload, next): Promise<PreExecuteDecision> => {
        const decision = decideFor({
          tool: payload.name,
          args: payload.args,
          session: payload.session,
          userRules,
          sessionRules: grants.rulesOf(payload.session),
          mode,
          root: options.root,
          extraRoots: grants.extraRootsOf(payload.session),
          fence: ctx.tryUse(fenceFacts)?.forSession(payload.session),
        });
        let finalVerdict = decision.verdict;
        let finalReason = decision.reason;
        if (decision.verdict === "ask") {
          const answer = await ask(payload.name, decision, payload.session);
          finalVerdict = answer === "allow" ? "allow" : "deny";
          finalReason = answer === "allow" ? `${decision.reason} (approved)` : decision.reason;
        }
        ctx.emit(permissionDecided, {
          tool: payload.name,
          verdict: finalVerdict,
          resolvedBy: decision.resolvedBy,
          reason: finalReason,
          ...(payload.session !== undefined ? { session: payload.session } : {}),
        });
        const downstream = await next(payload); // 内核 I2：必须调 next
        if (finalVerdict === "deny") return { kind: "deny", reason: `permission:${finalReason}` };
        return downstream;
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }) => grants.evict(session));
      const offGrants = ctx.provide(permissionGrants, grants);
      return () => {
        tearingDown = true; // 拒新 ask；在飞 ask 迟到裁决丢弃
        grants.seal();
        offDecide();
        offDisposed();
        offGrants();
      };
    },
  };
}
