// Tools 件 token：服务 + 两段管线 waterfall（docs/TOOLS.md §1.2/§1.3）。

import { defineService, defineWaterfall } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { ToolRegistry, PreExecuteDecision, ToolCallRequest, ToolOutcome } from "./types.ts";

export const toolRegistry = defineService<ToolRegistry>("tool-registry");

/** 权限否决位：中间件必须调 next（内核 I2），拒绝 = 调 next 后返回 deny（最外层 deny 胜）。
 *  session 由 dispatch 从请求透传（服务端事实，模型入参不可伪造）——权限类监听器会话键控依据。 */
export const toolsPreExecute = defineWaterfall<
  { readonly callId: string; readonly name: string; readonly args: unknown; readonly control?: true; readonly session?: SessionId },
  PreExecuteDecision
>("tools/pre-execute");

/** 执行包裹位：超时/重试/指标中间件挂点；可换 signal（重建对象调 next）或后处理 outcome */
export const toolsExecute = defineWaterfall<ToolCallRequest, ToolOutcome>("tools/execute");
