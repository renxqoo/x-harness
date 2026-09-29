import { defineService } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

export type TaskProbe =
  | { readonly kind: "hit" }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "miss" };

export type TaskOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export interface TaskSource {
  readonly kind: "agent" | "bash" | "workflow";
  probe(taskId: string, caller: SessionId | undefined): TaskProbe;
  stop(taskId: string, caller: SessionId | undefined): Promise<TaskOutcome>;
}

export interface TaskHub {
  registerSource(source: TaskSource): () => void;
  sources(): readonly TaskSource[];
}

export const taskHub = defineService<TaskHub>("task-hub");
