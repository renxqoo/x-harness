import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { Context, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { permissionBroker, permissionMode, modeRegistry } from "@x-harness/permission";
import { planMode } from "./plan-mode.ts";
import type { ProfileId } from "@x-harness/permission";
import { toolRegistry, toolsPreExecute } from "@x-harness/tools";
import { defineTool } from "@x-harness/tools";
import type { PreExecuteDecision } from "@x-harness/tools";
import { PLAN_SUBMIT_DESCRIPTION } from "./descriptions.ts";

const PLAN_CONTROL_ALLOW: ReadonlySet<string> = new Set([
  "plan_submit",
  "task_list",
  "task_get",
  "task_create",
  "task_update",
  "task_stop",
  "agent_spawn",
  "agent_message",
  "list_agents",
]);

export interface PlanControlService {
  enter(session: SessionId): void;
  exit(session: SessionId, to?: ProfileId): string;
  isPlan(): boolean;
  readonly owner: SessionId | undefined;
}

export const planControl = defineService<PlanControlService>("plan/control");

export interface PlanSubmitOptions {
  readonly liftTo?: ProfileId;
  readonly mainSession?: SessionId;
}

const schema = Type.Object({
  plan: Type.String({ description: "The complete plan to present for approval" }),
});

export function createPlanSubmitPlugin(options: PlanSubmitOptions = {}): Plugin {
  const liftTo: ProfileId = options.liftTo === "plan" ? "auto" : (options.liftTo ?? "auto");
  return {
    name: "tool-plan",
    inject: ["tools"],
    softInject: ["permission"],
    apply: (ctx: Context) => {
      let live = true;
      ctx.effect(() => {
        live = false;
      });
      let owner: SessionId | undefined = options.mainSession;
      const service: PlanControlService = {
        enter: (session) => {
          owner = session;
          ctx.tryUse(permissionMode)?.set("plan");
        },
        exit: (session, to) => {
          void session;
          owner = undefined;
          const target = to === undefined || to === "plan" ? liftTo : to;
          ctx.tryUse(permissionMode)?.set(target);
          return target;
        },
        isPlan: () => ctx.tryUse(permissionMode)?.get() === "plan",
        get owner(): SessionId | undefined {
          return owner;
        },
      };
      const offControl = ctx.provide(planControl, service);
      const offPlanMode = ctx.tryUse(modeRegistry)?.register(planMode);
      const tool = defineTool({
        name: "plan_submit",
        description: PLAN_SUBMIT_DESCRIPTION,
        inputSchema: schema,
        isControlTool: true,
        execute: async (args: Static<typeof schema>, exec) => {
          const mode = ctx.tryUse(permissionMode);
          if (mode === undefined) {
            return { content: "no-permission-service: plan_submit requires the permission service (world assembled without fenceKit)", isError: true };
          }
          if (mode.get() !== "plan") {
            return { content: `not-in-plan-mode: current permission mode is ${mode.get()}; plan approval only applies in plan mode`, isError: true };
          }
          if (owner === undefined || exec.session !== owner) {
            return { content: "not-plan-owner: plan approval is only available to the session that entered plan mode (anchor via planControl.enter or planKit mainSession); send findings to that session instead", isError: true };
          }
          const broker = ctx.tryUse(permissionBroker);
          if (broker === undefined) {
            return { content: "no-approval-channel: permission broker absent — the plan cannot be approved here; report this to the user", isError: true };
          }
          const reply = await broker.ask({
            tool: "plan_submit",
            summary: "Approve plan",
            reason: "plan mode: approve this plan?",
            options: ["once"],
            ...(exec.session !== undefined ? { session: exec.session } : {}),
          });
          if (!live || exec.signal.aborted) {
            return { content: "approval arrived after cancellation — ignored; still in plan mode", isError: true };
          }
          if (reply.verdict === "allow") {
            owner = undefined;
            mode.set(liftTo);
            return { content: `Plan approved — plan mode lifted (permission mode: ${liftTo}). Proceed with the implementation exactly as approved.` };
          }
          return { content: "Plan not approved — stop and wait for the user's direction. Do not resubmit unless the user asks.", concludesTurn: true };
        },
      });
      const offTool = ctx.use(toolRegistry).register(tool);
      const offGate = ctx.on(toolsPreExecute, async (payload, next): Promise<PreExecuteDecision> => {
        const downstream = await next(payload);
        if (downstream.kind === "deny") return downstream;
        if (payload.control !== true) return downstream;
        if (ctx.tryUse(permissionMode)?.get() !== "plan") return downstream;
        if (PLAN_CONTROL_ALLOW.has(payload.name)) return downstream;
        return { kind: "deny", reason: `plan: control tool ${payload.name} is not on the plan allowlist (read-only mode)` };
      });
      return () => {
        offPlanMode?.();
        offGate();
        offTool();
        offControl();
      };
    },
  };
}
