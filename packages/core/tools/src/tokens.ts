import { defineService, defineWaterfall } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import type { ToolRegistry, PreExecuteDecision, ToolCallRequest, ToolOutcome } from "./types.ts";

export const toolRegistry = defineService<ToolRegistry>("tool-registry");

export const toolsPreExecute = defineWaterfall<
  { readonly callId: string; readonly name: string; readonly args: unknown; readonly control?: true; readonly kind?: string; readonly readsSubtree?: true; readonly session?: SessionId },
  PreExecuteDecision
>("tools/pre-execute");

export const toolsExecute = defineWaterfall<ToolCallRequest, ToolOutcome>("tools/execute");
