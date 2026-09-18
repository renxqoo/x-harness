// agent-delegation 插件（docs/AGENT-DELEGATION.md §1）：装配血缘表/通知监听/工具族；
// spawn 决策流（类型解析→深度→并发→建子→断信号防线）；dispose 级联（tearing-down 门先行）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken } from "@x-harness/agent-loop";
import { agentStatus } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolRegistry } from "@x-harness/tools";
import type { ToolExecContext } from "@x-harness/tools";
import { createLineage, forkSeed, inheritDial, narrowTools } from "./lineage.ts";
import type { ChildRow } from "./lineage.ts";
import { childReport, createNotifier } from "./notify.ts";
import { delegationTools, notFound, reportText } from "./tools.ts";
import type { DelegationOptions, SubagentType } from "./types.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_REPORT_CAP = 8_000;

function countValue(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateOptions(options: DelegationOptions): { maxDepth: number; maxConcurrent: number; reportCap: number } {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const reportCap = options.reportCap ?? DEFAULT_REPORT_CAP;
  if (!countValue(maxDepth) || !countValue(maxConcurrent) || !countValue(reportCap) || reportCap === 0) {
    throw new Error("agent-delegation: maxDepth/maxConcurrent/reportCap must be non-negative safe integers (reportCap > 0)");
  }
  return { maxDepth, maxConcurrent, reportCap };
}

export function createAgentDelegationPlugin(options: DelegationOptions): Plugin {
  const limits = validateOptions(options);
  return {
    name: "agent-delegation",
    inject: ["session", "tools", "agent-loop"],
    apply: (ctx: Context): Disposer => {
      const loop = ctx.use(agentLoopServiceToken);
      const store = ctx.use(sessionStore);
      const registry = ctx.use(toolRegistry);
      const lineage = createLineage();
      let tearingDown = false;

      const rowOf = (ctx: ToolExecContext, agentId: string): { ok: true; row: ChildRow } | { ok: false; reason: string } => {
        const row = [...lineage.rows.values()].find((entry) => entry.agentId === agentId);
        if (row === undefined) return { ok: false, reason: notFound(agentId) };
        if (ctx.session === undefined || ctx.session !== row.parent) {
          return { ok: false, reason: `not-owner:${agentId}; you can only address sub-agents you spawned` };
        }
        return { ok: true, row };
      };

      const adoptOrphan = async (row: ChildRow): Promise<void> => {
        const childHandle = loop.get(row.sessionId);
        if (childHandle !== undefined) {
          childHandle.agent.cancel("parent-gone");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        }
        lineage.drop(row.sessionId);
      };

      /** 类型解析（含 fork 种子与 type.tools 注册名校验） */
      const resolveType = (
        caller: SessionId,
        typeName: string | undefined,
      ): { ok: true; type: SubagentType & { readonly name: string }; seed: readonly object[]; forked: boolean } | { ok: false; reason: string } => {
        if (typeName === "fork") {
          const parentSession = store.get(caller);
          const seed = parentSession === undefined ? [] : forkSeed(parentSession);
          return { ok: true, type: { name: "fork" }, seed, forked: seed.length > 0 };
        }
        if (typeName === undefined || typeName === "") return { ok: true, type: { name: "(untyped)" }, seed: [], forked: false };
        const def = options.types[typeName];
        if (def === undefined) {
          const available = Object.keys(options.types).join(", ");
          return { ok: false, reason: `invalid-args:unknown type '${typeName}'; available types: ${available === "" ? "(none registered)" : available}` };
        }
        if (def.tools !== undefined) {
          const registered = new Set(registry.schemas().map((tool) => tool.name));
          const unknown = def.tools.filter((name) => !registered.has(name));
          if (unknown.length > 0) {
            return { ok: false, reason: `invalid-args:type '${typeName}' allows unregistered tools: ${unknown.join(", ")}` };
          }
        }
        return { ok: true, type: { ...def, name: typeName }, seed: [], forked: false };
      };

      /** 父末次 request/header 折叠（全新子无 header——模型/线路继承源） */
      const lastHeaderOf = (caller: SessionId): { model?: string; provider?: string } | undefined => {
        const session = store.get(caller);
        if (session === undefined) return undefined;
        let header: { model?: string; provider?: string } | undefined;
        for (const event of session.events()) {
          if (event.type === "request/header") {
            header = { model: event.data.model, ...(event.data.provider !== undefined ? { provider: event.data.provider } : {}) };
          }
        }
        return header;
      };

      /** 建子 + 登记 + 断信号防线（含 forked 种子与白名单烘进 options） */
      const buildChild = async (input: {
        readonly execCtx: ToolExecContext;
        readonly type: SubagentType & { readonly name: string };
        readonly seed: readonly object[];
        readonly forked: boolean;
        readonly depth: number;
        readonly displayName: string | undefined;
        readonly prompt: string;
        readonly freshFork: boolean;
      }): Promise<{ ok: true; row: ChildRow; text: string } | { ok: false; reason: string }> => {
        const { execCtx, type, seed, forked, depth } = input;
        if (tearingDown) return { ok: false, reason: "denied:delegation plugin is shutting down" }; // teardown 期不登记脱管子
        const parentHandle = loop.get(execCtx.session as SessionId);
        if (parentHandle === undefined) return { ok: false, reason: `not-found:parent agent ${String(execCtx.session)} is not live` };
        const dial = inheritDial(parentHandle, type, lastHeaderOf(execCtx.session as SessionId));
        const effectiveTools = narrowTools(parentHandle.agent.options.tools, type.tools);
        const made = await loop.create({
          ...(forked ? { session: { seed: seed as never, parent: execCtx.session } } : { session: { parent: execCtx.session as SessionId } }),
          agent: {
            ...dial,
            ...(type.prompt !== undefined ? { systemPrompt: type.prompt } : {}),
            ...(effectiveTools !== undefined ? { tools: [...effectiveTools] } : {}),
          },
        });
        if (!made.ok) return { ok: false, reason: `spawn-failed:${made.reason}` };
        const childHandle = made.value;
        const agentId = lineage.mintAgentId();
        const name = input.displayName !== undefined && input.displayName !== "" ? input.displayName : type.name;
        const row: ChildRow = {
          agentId,
          sessionId: childHandle.agent.session.id,
          name,
          type: type.name,
          parent: execCtx.session as SessionId,
          depth,
          occupied: true,
          armed: false,
          running: false,
          stopped: false,
        };
        lineage.register(row);
        if (execCtx.signal.aborted) {
          await childHandle.dispose(); // execute 内断信号：不遗孤儿子
          lineage.drop(row.sessionId);
          return { ok: false, reason: "aborted:spawn cancelled before dispatch" };
        }
        childHandle.agent.followup(input.prompt);
        const forkNote = input.freshFork ? " (parent has no completed turns — started fresh)" : "";
        const text = `Spawned ${row.agentId} (name '${row.name}', session ${String(row.sessionId)}). It runs in the background; an [agent-notification] message will arrive on completion. End your turn and wait instead of polling agent_output.${forkNote}`;
        return { ok: true, row, text };
      };

      const spawn = async (
        execCtx: ToolExecContext,
        input: { prompt: string; type?: string; name?: string },
      ): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
        if (execCtx.session === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
        if (typeof input.prompt !== "string" || input.prompt === "") return { ok: false, reason: "invalid-args:prompt must be a non-empty string" };
        const resolved = resolveType(execCtx.session, input.type);
        if (!resolved.ok) return resolved;
        const { type, seed, forked } = resolved;
        const depth = lineage.depthOf(execCtx.session) + 1;
        if (depth > limits.maxDepth) {
          return { ok: false, reason: `denied:max-depth ${String(limits.maxDepth)} exceeded (this spawn would be depth ${String(depth)})` };
        }
        const busy = lineage.occupiedBy(execCtx.session);
        if (busy >= limits.maxConcurrent) {
          return { ok: false, reason: `busy:concurrency limit reached (${String(busy)} busy sub-agents); wait for [agent-notification] before spawning more` };
        }
        return buildChild({
          execCtx,
          type,
          seed,
          forked,
          depth,
          displayName: input.name,
          prompt: input.prompt,
          freshFork: input.type === "fork" && !forked,
        });
      };

      const message = (execCtx: ToolExecContext, agentId: string, text: string): { ok: true; text: string } | { ok: false; reason: string } => {
        const found = rowOf(execCtx, agentId);
        if (!found.ok) return found;
        const childHandle = loop.get(found.row.sessionId);
        if (childHandle === undefined) return { ok: false, reason: notFound(agentId) };
        childHandle.agent.steer(text); // busy → 步边界排队；idle → 唤醒（收件箱三态）
        return { ok: true, text: `Delivered to ${agentId} (consumed at the next step boundary if busy; wakes it if idle).` };
      };

      const output = (execCtx: ToolExecContext, agentId: string): { ok: true; text: string } | { ok: false; reason: string } => {
        const found = rowOf(execCtx, agentId);
        if (!found.ok) return found;
        const childSession = store.get(found.row.sessionId);
        if (childSession === undefined) return { ok: false, reason: notFound(agentId) };
        return { ok: true, text: reportText(found.row, childReport(childSession.events()), limits.reportCap) };
      };

      const stop = async (execCtx: ToolExecContext, agentId: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
        const found = rowOf(execCtx, agentId);
        if (!found.ok) return found;
        const row = found.row;
        if (row.stopped) return { ok: true, text: `${agentId} already stopped` }; // 幂等
        const childHandle = loop.get(row.sessionId);
        if (childHandle !== undefined) {
          childHandle.agent.cancel("agent-stop");
          await childHandle.agent.whenIdle();
        }
        row.stopped = true;
        row.occupied = false; // 槽释放；armed 置位者由通知门丢弃（cancel 后 idle 仍会触发通知——tearing-down 只管插件卸载；stop 后通知如实送达）
        return { ok: true, text: `Stopped ${agentId}; it can be messaged again with agent_message.` };
      };

      const list = (execCtx: ToolExecContext) =>
        [...lineage.rows.values()]
          .filter((row) => row.parent === execCtx.session)
          .map((row) => ({
            agentId: row.agentId,
            sessionId: String(row.sessionId),
            name: row.name,
            type: row.type,
            depth: row.depth,
            status: viewStatus(row),
          }));

      const viewStatus = (row: ChildRow): "stopped" | "running" | "idle" => {
        if (row.running) return "running"; // 停止后再 message 复活的子如实显示 running
        if (row.stopped) return "stopped";
        return "idle";
      };

      const notifier = createNotifier({ loop, store, rows: lineage.rows, isTearingDown: () => tearingDown, adoptOrphan });
      const offStatus = ctx.on(agentStatus, notifier);
      const offs = delegationTools({ spawn, message, output, stop, list }).map((tool) => registry.register(tool));

      return () => {
        tearingDown = true; // 通知门先行：级联 cancel 的 abort 通知不得 steer 复活父
        offStatus();
        for (const off of offs) off();
        const cascade = [...lineage.rows.values()].map(async (row) => {
          const childHandle = loop.get(row.sessionId);
          if (childHandle === undefined) return;
          childHandle.agent.cancel("delegation-disposed");
          await childHandle.agent.whenIdle();
          await childHandle.dispose();
        });
        lineage.rows.clear();
        return Promise.allSettled(cascade).then(() => {});
      };
    },
  };
}

