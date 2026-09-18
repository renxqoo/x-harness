// agent-delegation 插件装配（docs/AGENT-DELEGATION.md §3/§7）：类型 .md 加载 + system-prompt
// 注入（kick 边沿 mtime 探测重载）+ 血缘/通知/动词接线；dispose 级联（tearing-down 门先行）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, agentStatus } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import { systemPrompt } from "@x-harness/system-prompt";
import { createLineage } from "./lineage.ts";
import type { ChildRow } from "./lineage.ts";
import { loadAgentTypes, resolveAgentDirs, typesFingerprint } from "./types-loader.ts";
import type { DelegationOptions, LoadedAgentType } from "./types.ts";
import { createNotifier } from "./notify.ts";
import { spawnAgent } from "./spawn.ts";
import type { SpawnInput } from "./spawn.ts";
import { listAgents, message, output, stop } from "./verbs.ts";
import type { VerbDeps } from "./verbs.ts";
import { delegationTools } from "./tools.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_REPORT_CAP = 8_000;

/** 配置垃圾值 fail-fast（非负安全整数） */
export function validateOptions(options: DelegationOptions): { maxDepth: number; maxConcurrent: number; reportCap: number } {
  const sane = (value: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const reportCap = options.reportCap ?? DEFAULT_REPORT_CAP;
  if (!sane(maxDepth) || !sane(maxConcurrent) || !sane(reportCap) || reportCap === 0) {
    throw new Error("agent-delegation: maxDepth/maxConcurrent/reportCap must be non-negative safe integers (reportCap > 0)");
  }
  if (options.agentsDirs !== undefined && (!Array.isArray(options.agentsDirs) || options.agentsDirs.some((dir) => typeof dir !== "string" || dir === ""))) {
    throw new Error("agent-delegation: agentsDirs must be an array of non-empty strings");
  }
  return { maxDepth, maxConcurrent, reportCap };
}

/** 类型清单注入块（<system-reminder> 语义——无类型时为空串不占位） */
export function renderTypesBlock(types: Readonly<Record<string, LoadedAgentType>>): string {
  const names = Object.keys(types).sort();
  if (names.length === 0) return "";
  const lines = names.map((name) => {
    const type = types[name];
    return `- ${name} — ${type?.description ?? ""}${type?.model !== undefined ? ` (model: ${type.model})` : ""}`;
  });
  return `<system-reminder>\nAvailable agent types:\n${lines.join("\n")}\n</system-reminder>`;
}

export function createAgentDelegationPlugin(options: DelegationOptions = {}): Plugin {
  const limits = validateOptions(options);
  const dirs = resolveAgentDirs(options.agentsDirs);
  return {
    name: "agent-delegation",
    inject: ["session", "tools", "agent-loop", "system-prompt"],
    apply: async (ctx: Context): Promise<Disposer> => {
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);
      const prompt = ctx.use(systemPrompt);

      let current: Readonly<Record<string, LoadedAgentType>> = {};
      let fingerprint = "";
      const refreshTypes = async (): Promise<void> => {
        const next = await typesFingerprint(dirs);
        if (next === fingerprint) return;
        fingerprint = next;
        const loaded = await loadAgentTypes(dirs);
        current = loaded.types;
        for (const warning of loaded.warnings) options.onWarn?.(warning);
      };
      await refreshTypes(); // 装配期全量并等待——apply 完成即类型可用（loadPlugins 语义）

      const offVariable = prompt.variable("agentTypes", () => renderTypesBlock(current));
      const offSection = prompt.section({ name: "subagent-types", text: "{{agentTypes}}" });

      const lineage = createLineage();
      let tearingDown = false;

      const adoptOrphan = async (row: ChildRow): Promise<void> => {
        const childHandle = loop.get(row.sessionId);
        if (childHandle !== undefined) {
          childHandle.agent.cancel("parent-gone");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        }
        lineage.drop(row.sessionId);
      };

      const spawnDeps = { loop, store, registry, lineage, limits, types: () => current, isTearingDown: () => tearingDown };
      const verbDeps: VerbDeps = { loop, store, lineage, reportCap: limits.reportCap, adoptOrphan };

      const notifier = createNotifier({ loop, store, getRow: (session) => lineage.bySession(session), isTearingDown: () => tearingDown, adoptOrphan });
      const offStatus = ctx.on(agentStatus, (payload) => {
        notifier(payload);
        if (payload.status === "running") void refreshTypes().catch(() => {
          /* 探测失败保持现状：下次 kick 再试 */
        });
      });
      const offs = delegationTools({
        spawn: (execCtx, input: SpawnInput) => spawnAgent(spawnDeps, execCtx, input),
        message: (execCtx, input) => message(verbDeps, execCtx, input),
        output: (execCtx, input) => output(verbDeps, execCtx, input),
        stop: (execCtx, taskId) => stop(verbDeps, execCtx, taskId),
        list: (execCtx) => listAgents(verbDeps, execCtx),
      }).map((tool) => registry.register(tool));

      return () => {
        tearingDown = true; // 通知门先行：级联 cancel 的 abort 通知不得 steer 复活父
        offStatus();
        for (const off of offs) off();
        const cascade = lineage.rows().map(async (row) => {
          const childHandle = loop.get(row.sessionId);
          if (childHandle === undefined) return;
          childHandle.agent.cancel("delegation-disposed");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        });
        offSection();
        offVariable();
        return Promise.allSettled(cascade).then(() => {});
      };
    },
  };
}
