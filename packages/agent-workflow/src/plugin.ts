import type { Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { sessionCreated } from "@x-harness/session";
import type { Context } from "@x-harness/core";
import { sessionStore } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import { defineService } from "@x-harness/core";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { delegationView } from "@x-harness/agent-delegation";
import type { WorkflowOptions } from "./types.ts";
import { createRuntime } from "./runtime.ts";
import { scanAndRecover } from "./resume.ts";
import { workflowSubmitTool } from "./tools.ts";

export function createAgentWorkflowPlugin(options: WorkflowOptions): Plugin {
  return {
    name: "agent-workflow",
    inject: ["session", "tools", "agent-loop"],
    softInject: ["agent-delegation", "task-tools"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);
      const view = ctx.tryUse(delegationView);
      const archive = ctx.tryUse((await import("@x-harness/session")).sessionArchive);
      const deps = { ctx, ...options, loop, store, view: view ?? undefined, ...(archive !== undefined ? { archive } : {}) };
      const runtime = createRuntime(deps);

      void (async () => {
        await scanAndRecover({ ...deps, warmColdIndex: runtime.warmColdIndex }, (run) => ({ onCycleEnd: runtime.attach(run), redispatch: (r, caller) => runtime.redispatch(r, caller), detach: runtime.detach })).catch(() => {
        });
        await (await import("./journal.ts")).gcRuns(options.root, { maxAgeMs: 7 * 24 * 3_600_000 }).catch(() => {
        });
      })();

      const offCreated = ctx.on(sessionCreated, ({ header }) => {
        queueMicrotask(() => {
          void runtime.onSessionAlive(header.id).catch(() => {
          });
        });
      });

      const { taskHub } = await import("@x-harness/task-tools");
      const hub = ctx.tryUse(taskHub);
      let offSource: (() => void) | undefined;
      if (hub !== undefined) {
        offSource = hub.registerSource({
          kind: "workflow",
          probe: (taskId: string, caller: SessionId | undefined) => runtime.probeTask(taskId, caller),
          stop: (taskId: string, caller: SessionId | undefined) => runtime.stopTask(taskId, caller),
        });
      }
      const offView = ctx.provide(workflowView, { rebind: runtime.rebind, submit: runtime.submit });
      const offTool = options.userCommandOnly === false ? registry.register(workflowSubmitTool(runtime)) : undefined;
      return () => {
        offView();
        offCreated();
        offTool?.();
        offSource?.();
        void runtime.dispose();
      };
    },
  };
}

export type { WorkflowOptions, WorkflowRuntime } from "./types.ts";

export interface WorkflowView {
  rebind(next: import("@x-harness/session").SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
  submit(caller: import("@x-harness/session").SessionId | undefined, input: import("./types.ts").SubmitInput): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
}
export const workflowView = defineService<WorkflowView>("workflow/view");
