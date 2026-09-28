// plan 模式策略件（docs/PERMISSION-MODE-FLAG.md plan 模式节）——**自持全部 plan 策略，
// 其他包零感知**（重构裁决：不做散点判断——delegation/workflow/facts 不掺 plan 语义）：
//
// 1. planControl 服务：plan 档的进出与 owner 锚定。enter(session) 锚定「谁开的 plan」，
//    exit 任意会话可调（收紧无害）；宿主 UX（CLI /plan、hub permission/set_mode）调它，
//    不再裸调 permissionMode.set。
// 2. plan_submit 资格 = caller === owner：不问「什么是子代理」，只问「是不是开 plan 的
//    那个会话」——委派/跨进程/任何非 owner 会话一律拒（blast radius 关，无需 delegation
//    依赖）。owner 缺席（宿主未传 mainSession 且未经 enter）= fail-safe 拒绝并给出可行动
//    的错误文案。
// 3. 工具策略（toolsPreExecute 中间件）：plan 档下**控制类动词默认拒 + 白名单放行**
//    （fail-safe——将来新增控制工具自动被拒，加白单源一行）。非控制动词不干预——
//    写/命令族的 plan-deny 归 permission 既有裁决（含拒因教育）。
// 4. 迟到裁决守卫：world 拆卸（teardown）或本调用 abort 后到达的 allow 不解档。
//
// 拒绝语义（用户裁决）：deny → concludesTurn 收轮等指示——用户下一条消息有内容就带续、
// 没有即终止，工具不自动 refine。liftTo 不变量：解档目标绝不取 plan（宿主规范化 +
// 插件层误配回退 auto）。人类命令面（/workflow 等）不设闸——plan 约束的是 agent，
// 人显式提交即批准动作。

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

/** plan 档控制动词白名单（只读/自管理）。委派三件在列：plan 档的**研究型委派是正当
 *  模式**（子代理自身工具面同受 plan-deny——环境变更仍不可达；message 是报告通道，
 *  收件箱是会话态非环境）。单源增删：新控制动词默认拒，需要时在此加白 */
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

/** plan 档控制服务：进出 + owner 锚定（宿主 UX 的唯一入口——不裸调 permissionMode.set） */
export interface PlanControlService {
  /** 进 plan 档并锚定 owner 会话（重复 enter = 重锚——/new 换会话后 re-toggle 即恢复资格） */
  enter(session: SessionId): void;
  /** 出 plan 档（任意会话可调——收紧无害）；to 缺省 = liftTo；返回实际生效档 */
  exit(session: SessionId, to?: ProfileId): string;
  /** 当前是否 plan 档（permissionMode 服务缺席 = false） */
  isPlan(): boolean;
  /** 当前 owner 会话（未锚定 = undefined——plan_submit 将 fail-safe 拒绝） */
  readonly owner: SessionId | undefined;
}

export const planControl = defineService<PlanControlService>("plan/control");

export interface PlanSubmitOptions {
  /** 批准后解档目标（宿主应传自己的装配缺省档：CLI sandboxed-auto、hub 合并缺省；
   *  "plan" 视为误配回退 "auto"——解档永不留在 plan） */
  readonly liftTo?: ProfileId;
  /** 初始 owner 会话（--permission plan / settings 默认 plan 的装配期锚——两宿主都
   *  有 mainSessionId；缺席且未经 enter 则 plan_submit fail-safe 拒绝） */
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
    softInject: ["permission"], // modeRegistry 在场则排后——后注册 plan 富策略覆盖严格缺省
    apply: (ctx: Context) => {
      let live = true; // 迟到裁决守卫：拆卸后 in-flight ask 的 allow 丢弃
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
          void session; // 任意会话可出（收紧无害）——签名留 session 面：将来收紧到 owner 的单点
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
      // plan 模式富策略注册（同 id 后者胜——覆盖 permission 内置 planDefaultMode；
      // 无 permission 装配世界 tryUse 缺席 → 不注册，快照/审批面自持不受影响）
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
            owner = undefined; // 解档即清锚
            mode.set(liftTo);
            return { content: `Plan approved — plan mode lifted (permission mode: ${liftTo}). Proceed with the implementation exactly as approved.` };
          }
          // 拒绝语义（用户裁决）：收轮等指示——用户下一条消息有内容就带续规划，没有即终止；
          // 工具不自动 refine（结果已落账，下一轮模型可见）
          return { content: "Plan not approved — stop and wait for the user's direction. Do not resubmit unless the user asks.", concludesTurn: true };
        },
      });
      const offTool = ctx.use(toolRegistry).register(tool);
      // 控制动词策略：plan 档默认拒 + 白名单（fail-safe——新增控制工具自动被拒）。
      // 中间件纪律：必调 next（内核 I2），deny 在 next 后返回（最外层 deny 胜）。
      const offGate = ctx.on(toolsPreExecute, async (payload, next): Promise<PreExecuteDecision> => {
        const downstream = await next(payload);
        if (downstream.kind === "deny") return downstream;
        if (payload.control !== true) return downstream; // 非控制动词归 permission 裁决
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
