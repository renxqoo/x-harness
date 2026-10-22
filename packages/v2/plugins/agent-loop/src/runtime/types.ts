import type { PluginInvocation } from "../../../../core/src/index";
import type { llmRequest } from "../../../llm/src/index";
import type { tools } from "../../../tools/src/index";
import type { toolScheduler } from "../../../tool-scheduler/src/index";
import type {
  agentLoop,
  agentContext,
  agentCheckpoint,
  agentContinue,
  agentRunAccess,
  agentEvent,
} from "../contracts";
export type AgentCall = PluginInvocation<{
  requires: {
    llmRequest: typeof llmRequest;
    tools: typeof tools;
    toolScheduler: typeof toolScheduler;
  };
  provides: {
    agentLoop: typeof agentLoop;
    agentContext: typeof agentContext;
    agentCheckpoint: typeof agentCheckpoint;
    agentContinue: typeof agentContinue;
    agentRunAccess: typeof agentRunAccess;
    agentEvent: typeof agentEvent;
  };
}>;

export interface RunProgress {
  step: number;
  toolsMayHaveRun: boolean;
}
