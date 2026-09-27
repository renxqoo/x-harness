// plan_submit 控制工具（docs/PERMISSION-MODE-FLAG.md plan 模式节——审批协议件）：
// plan 档的出口——方案文本经 permission broker 问用户，批准即解档（liftTo——宿主
// 装配缺省档，CLI sandboxed-auto / hub 合并缺省），拒绝留档 refine。控制类工具
// （isControlTool——动词自身无环境副作用，permission 裁决面直通，不双重问询）。
// 服务面 execute 期懒解析（broker 是宿主提供件——permission 插件内部同款 tryUse
// 时点；不设 softInject 免插件序耦合）；缺席优雅降级：无 permission 装配的世界
// （纯工具世界）非 plan 档直接短路；plan 档但无 broker 时明确报错（有闸无门：
// 审批无通道不静默解档）。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { Context, Plugin } from "@x-harness/core";
import { permissionBroker, permissionMode } from "@x-harness/permission";
import type { ProfileId } from "@x-harness/permission";
import { toolRegistry } from "@x-harness/tools";
import { defineTool } from "@x-harness/tools";
import { PLAN_SUBMIT_DESCRIPTION } from "./descriptions.ts";

export interface PlanSubmitOptions {
  /** 批准后解档目标（缺省 "auto"——宿主应传自己的装配缺省档：CLI sandboxed-auto、
   *  hub 合并缺省；解档回装配态而非硬编码，围栏姿势不因审批漂移） */
  readonly liftTo?: ProfileId;
}

const schema = Type.Object({
  plan: Type.String({ description: "The complete plan to present for approval" }),
});

export function createPlanSubmitPlugin(options: PlanSubmitOptions = {}): Plugin {
  const liftTo = options.liftTo ?? "auto";
  return {
    name: "tool-plan",
    inject: ["tools"],
    apply: (ctx: Context) => {
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
          const current = mode.get();
          if (current !== "plan") {
            return { content: `not-in-plan-mode: current permission mode is ${current}; plan approval only applies in plan mode`, isError: true };
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
          if (reply.verdict === "allow") {
            mode.set(liftTo);
            return { content: `Plan approved — plan mode lifted (permission mode: ${liftTo}). Proceed with the implementation exactly as approved.` };
          }
          return { content: "Plan not approved — stay in plan mode, refine the plan, and submit it again." };
        },
      });
      return ctx.use(toolRegistry).register(tool);
    },
  };
}
