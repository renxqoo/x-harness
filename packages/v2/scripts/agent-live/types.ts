import type { Host } from "../../core/src/index";
import type { AgentCheckpoint } from "../../plugins/agent-loop/src/index";

export interface JourneyOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly onStep?: (step: number) => void;
}
export interface JourneyState {
  readonly directory: string;
  readonly total: number;
  readonly receipt: string;
  readonly calls: string[];
  readonly checkpoints: AgentCheckpoint[];
  readonly hosts: Host[];
}
