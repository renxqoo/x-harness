import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecEnv, ProcHandle, SpawnRequest, SpawnResult } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { ToolExecContext } from "@x-harness/tools";
import { createBashTool } from "../bash.ts";
import type { BashEscalate } from "../bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "../tasks.ts";

function makeRecorder(envRoot = "/w"): { env: ExecEnv; spawns: { exec?: string }[]; failContained: boolean } {
  const spawns: { exec?: string }[] = [];
  const state = { failContained: true };
  const makeProc = (fail: boolean): ProcHandle => {
    let settle!: () => void;
    const settled = new Promise<void>((r) => {
      settle = r;
    });
    const encoder = new TextEncoder();
    const exited = settled.then(() => ({ code: (fail ? 1 : 0) as number | null, signal: null as string | null }));
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (text !== "") controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const handle = {
      stdout: stream(fail ? "" : "ok-out"),
      stderr: stream(fail ? "sandbox deny: Operation not permitted" : ""),
      exited,
      settled,
      kill: () => Promise.resolve(),
    } as unknown as ProcHandle;
    setTimeout(() => settle(), 5);
    return handle;
  };
  const env: ExecEnv = {
    kind: "local",
    root: envRoot,
    realpath: async (p) => p,
    stat: async () => ({ ok: false, reason: "not_found" as const }),
    openRead: async () => ({ ok: false, reason: "not_found" as const }),
    writeFileAtomic: async () => ({ ok: true }) as never,
    readDir: async () => [] as never,
    spawn: async (req: SpawnRequest): Promise<SpawnResult> => {
      if (req.exec === undefined) spawns.push({});
      else spawns.push({ exec: req.exec });
      return { ok: true, proc: makeProc(req.exec !== "direct" && state.failContained) };
    },
  };
  return {
    env,
    spawns,
    get failContained(): boolean {
      return state.failContained;
    },
    set failContained(v: boolean) {
      state.failContained = v;
    },
  };
}

function ctxOf(fields: { exec?: "direct" | "contained"; escalatable?: true }): ToolExecContext {
  return { callId: "c", name: "bash", signal: new AbortController().signal, ...fields };
}

describe("on-failure 升级流（bash 工具）", () => {
  it("contained 失败 + fenceSuspect + 批准 → direct 重执行一次；弹窗材料含失败原文", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-esc-"));
    try {
      const recorder = makeRecorder();
      const seen: { command: string; failureText: string }[] = [];
      const escalate: BashEscalate = async (fields) => {
        seen.push({ command: fields.command, failureText: fields.failureText });
        return seen.length === 1 ? "allow" : "deny";
      };
      const tool = makeTool(root, recorder.env, escalate);
      const out = await tool.execute({ command: "echo probe" }, ctxOf({ exec: "contained", escalatable: true }));
      expect(out.content).toContain("[escalated: retried outside the sandbox after user approval]");
      expect(out.content).toContain("ok-out");
      expect(recorder.spawns).toEqual([{ exec: "contained" }, { exec: "direct" }]);
      expect(seen[0]?.failureText).toContain("Operation not permitted");
      expect(seen[0]?.command).toBe("echo probe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("配额（plugin 层）与形态门：无 escalatable 资格 / 非 fenceSuspect 失败 / direct 执行均不升级", async () => {
    const root = mkdtempSync(join(tmpdir(), "xh-escq-"));
    try {
      const recorder = makeRecorder();
      let calls = 0;
      const tool = makeTool(root, recorder.env, async () => {
        calls += 1;
        return "deny";
      });
      recorder.failContained = false;
      const ok = await tool.execute({ command: "echo fine" }, ctxOf({ exec: "contained", escalatable: true }));
      expect(ok.content).toContain("ok-out");
      expect(calls).toBe(0);
      recorder.failContained = true;
      const noQual = await tool.execute({ command: "echo q" }, ctxOf({ exec: "contained" }));
      expect(noQual.content).not.toContain("[escalated:");
      expect(calls).toBe(0);
      const directRun = await tool.execute({ command: "echo d" }, ctxOf({ exec: "direct" }));
      expect(directRun.content).toContain("ok-out");
      expect(calls).toBe(0);
      const denied = await tool.execute({ command: "echo n" }, ctxOf({ exec: "contained", escalatable: true }));
      expect(denied.content).not.toContain("[escalated:");
      expect(calls).toBe(1);
      expect(recorder.spawns.filter((s) => s.exec === "direct").length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeTool(root: string, env: ExecEnv, escalate: BashEscalate) {
  const tasks = new BackgroundTasks(defaultTaskLimits({ taskLogDir: root }));
  return createBashTool({
    gate: new PathGate(root),
    limits: { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, maxOutputBytes: 30_000, spillDir: root },
    env,
    tasks,
    escalate,
  });
}

describe("端到端：全真世界升级流（permission sandboxed-auto → dispatch 透传 → 桥 → 配额）", () => {
  it("contained 失败 → 结构化 escalate ask → 批准 → direct 重执行一次；同命令二次零问（配额）", async () => {
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const { toolsPlugin, toolRegistry } = await import("@x-harness/tools");
    const { permissionBroker, createPermissionPlugin } = await import("@x-harness/permission");
    const { createPermissionModesPlugin } = await import("@x-harness/permission-modes");
    const { mkdtempSync, rmSync: rm2 } = await import("node:fs");
    const { tmpdir: tmp2 } = await import("node:os");
    const { join: join2 } = await import("node:path");
    const { PathGate: Gate2 } = await import("@x-harness/tool-core");
    const root = mkdtempSync(join2(tmp2(), "xh-esc-e2e-"));
    try {
      const recorder = makeRecorder(root);
      const asks: { reason: string; options: string[]; summary?: string; escalate?: { command: string; failureText: string } }[] = [];
      let at = 0;
      const broker = {
        name: "test-broker",
        apply: (c: import("@x-harness/core").Context) =>
          c.provide(permissionBroker, {
            ask: async (input: import("@x-harness/permission").AskPayload) => {
              asks.push({ reason: input.reason, options: [...input.options], ...(input.summary !== undefined ? { summary: input.summary } : {}), ...(input.escalate !== undefined ? { escalate: input.escalate } : {}) });
              at += 1;
              return { verdict: at <= 1 ? "allow" : "deny" };
            },
          }),
      };
      const ctx = createContext();
      const unload = await loadPlugins(ctx, [
        toolsPlugin,
        (await import("../plugin.ts")).createBashPlugin({ gate: new Gate2(root), env: recorder.env, limits: { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, maxOutputBytes: 30_000, spillDir: root } }),
        createPermissionModesPlugin(), createPermissionPlugin({ root, mode: "sandboxed-auto" }),
        broker,
      ]);
      const reg = ctx.use(toolRegistry);
      const first = await reg.dispatch({ callId: "e2e-1", name: "bash", args: { command: "mytool run" }, signal: new AbortController().signal });
      expect(first.content).toContain("[escalated: retried outside the sandbox after user approval]");
      expect(asks).toHaveLength(1);
      expect(asks[0]?.options).toEqual(["once"]);
      expect(asks[0]?.summary).toBe("mytool run");
      expect(asks[0]?.escalate?.command).toBe("mytool run");
      expect(asks[0]?.escalate?.failureText).toContain("Operation not permitted");
      expect(recorder.spawns).toEqual([{ exec: "contained" }, { exec: "direct" }]);
      const second = await reg.dispatch({ callId: "e2e-2", name: "bash", args: { command: "mytool run" }, signal: new AbortController().signal });
      expect(second.content).not.toContain("[escalated:");
      expect(asks).toHaveLength(1);
      await ctx.dispose();
      void unload;
    } finally {
      rm2(root, { recursive: true, force: true });
    }
  });
});
