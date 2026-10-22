import { createHost, definePlugin } from "../../core/src/index";
import type { JsonValue } from "../../core/src/index";
import { createLlmPlugin, defineLlmProvider } from "../../plugins/llm/src/index";
import { createOpenaiPlugin } from "../../plugins/llm-openai/src/index";
import { createToolsPlugin, toolAccess, toolExecutionAccess } from "../../plugins/tools/src/index";
import {
  createToolSchedulerPlugin,
  toolScheduleAccess,
} from "../../plugins/tool-scheduler/src/index";
import {
  createAgentLoopPlugin,
  agentCheckpoint,
  agentRunAccess,
} from "../../plugins/agent-loop/src/index";
import { createLocalExecutionPlugin } from "../../plugins/execution-local/src/index";
import { createSessionPlugin, session } from "../../plugins/session/src/index";
import { createSqliteSessionPlugin } from "../../plugins/session-sqlite/src/index";
import { createJourneyTools } from "./create-journey-tools";
import { requireValue } from "./require-value";
import type { JourneyOptions, JourneyState } from "./types";

export async function openJourneyHost(options: JourneyOptions, state: JourneyState) {
  const host = requireValue(
    createHost({ limits: { callTimeoutMs: 300000, closeTimeoutMs: 10000, maxCallDepth: 256 } }),
  );
  state.hosts.push(host);
  const provider = requireValue(defineLlmProvider("agent-journey"));
  const policy = definePlugin({
    name: "journey-policy",
    requires: { agentRunAccess, toolScheduleAccess, toolAccess, toolExecutionAccess },
    setup(ctx) {
      const access = ctx.guard("agentRunAccess", (input) => ({
        ok: true,
        value:
          input.caller.origin.scopeId === "root"
            ? { kind: "allow" }
            : { kind: "deny", reason: "caller" },
      }));

      if (!access.ok) return access;

      const schedule = ctx.guard("toolScheduleAccess", (input) => ({
        ok: true,
        value:
          input.origin.pluginName === "agent-loop"
            ? { kind: "allow" }
            : { kind: "deny", reason: "delegate" },
      }));

      if (!schedule.ok) return schedule;

      const tools = ctx.guard("toolAccess", (input) => ({
        ok: true,
        value: ["agent-loop", "tool-scheduler"].includes(input.origin.pluginName ?? "")
          ? { kind: "allow" }
          : { kind: "deny", reason: "delegate" },
      }));

      if (!tools.ok) return tools;

      return ctx.guard("toolExecutionAccess", (input) =>
        Object.keys(input.plan.actions).every((key) => ["read", "write", "calculate"].includes(key))
          ? input.allow({ signal: ctx.signal })
          : { ok: true, value: { kind: "deny", reason: "action" } },
      );
    },
  });
  const checkpoints = definePlugin({
    name: "journey-checkpoints",
    requires: { agentCheckpoint, session },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", async (input, next, call) => {
        const head = await call.deps.session.get({ id: "invoice" });

        if (!head.ok)
          return { ok: false, error: { source: "agent-loop", code: "checkpoint-failed" } };

        const commitId = new Bun.CryptoHasher("sha256")
          .update(JSON.stringify([input.runId, input.step, input.phase]))
          .digest("hex");
        const saved = await call.deps.session.append({
          id: "invoice",
          expectedRevision: head.value.revision,
          commitId,
          entries: [
            {
              kind: "event",
              type: "agent/checkpoint",
              data: JSON.parse(JSON.stringify(input)) as JsonValue,
            },
          ],
        });

        if (!saved.ok)
          return { ok: false, error: { source: "agent-loop", code: "checkpoint-failed" } };

        state.checkpoints.push(input);
        return next(input);
      }),
  });
  requireValue(
    await host.install([
      requireValue(
        createOpenaiPlugin({
          api: "chat-completions",
          token: provider,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          limits: { headersTimeoutMs: 90000, idleTimeoutMs: 90000 },
          models: {
            [options.model]: {
              reasoning: {
                efforts: options.reasoningEffort ? [options.reasoningEffort] : [],
                budget: false,
                display: ["text"],
              },
            },
          },
        }),
      ),
      requireValue(
        createLlmPlugin({ providers: { selected: provider }, defaultProvider: "selected" }),
      ),
      requireValue(createToolsPlugin()),
      requireValue(createToolSchedulerPlugin()),
      policy,
      checkpoints,
      requireValue(
        createLocalExecutionPlugin({
          profiles: {
            invoice: {
              cwd: state.directory,
              readRoots: [state.directory],
              writeRoots: [state.directory],
            },
          },
        }),
      ),
      ...createJourneyTools(state),
      requireValue(createSqliteSessionPlugin({ path: `${state.directory}/session.sqlite` })),
      requireValue(createSessionPlugin({ namespace: "live-agent-journey" })),
      requireValue(createAgentLoopPlugin({ limits: { timeoutMs: 300000, maxSteps: 16 } })),
    ]),
  );
  return host;
}
