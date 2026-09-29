// thread/notify 生命周期测试（SESSION-WORKTREE-WORKFLOW §1.2/§7 阶段 1 验收点）：
// live-only 路由四态拒（parked/dead/retiring/spawning——无 wake 副作用）、observer 不重置 idle、
// worker 分派 target 三态（running→next-step / idle→next-turn 不唤醒 / 形状门拒）。

import { describe, expect, test } from "vitest";
import { LIVE_ONLY_COMMANDS, OBSERVER_COMMANDS, THREAD_SCOPED_COMMANDS } from "../protocol/internal.ts";
import { routeLiveOnly } from "../host/route-gates.ts";
import type { HubErrorShape } from "../shared/errors.ts";

function gatesWorld() {
  const failures: Array<{ id: string | undefined; type: string; error: HubErrorShape }> = [];
  const deliveries: Array<{ threadId: string; line: string }> = [];
  const deps = {
    emitFailure: (id: string | undefined, type: string, error: HubErrorShape) => {
      failures.push({ id, type, error });
    },
    deliver: (threadId: string, line: string) => {
      deliveries.push({ threadId, line });
      return true;
    },
  };
  return { failures, deliveries, deps };
}

describe("thread/notify 协议词表", () => {
  test("live-only 集 = {thread/notify}，且入线程域与观察者集（不重置 idle）", () => {
    expect(LIVE_ONLY_COMMANDS.has("thread/notify")).toBe(true);
    expect(LIVE_ONLY_COMMANDS.size).toBe(1);
    expect(THREAD_SCOPED_COMMANDS.has("thread/notify")).toBe(true);
    expect(OBSERVER_COMMANDS.has("thread/notify")).toBe(true);
  });
});

describe("live-only 路由门（routeLiveOnly）", () => {
  test("live 表项 → 投递 worker，无失败应答", () => {
    const world = gatesWorld();
    const consumed = routeLiveOnly({ id: "n1", type: "thread/notify", threadId: "t1", entry: { state: "live" }, line: "L" }, world.deps);
    expect(consumed).toBe(true);
    expect(world.deliveries).toEqual([{ threadId: "t1", line: "L" }]);
    expect(world.failures).toEqual([]);
  });

  test.each(["parked", "dead", "retiring", "spawning"] as const)("%s 表项态 → thread_not_live 拒，不投递", (state) => {
    const world = gatesWorld();
    const consumed = routeLiveOnly({ id: "n1", type: "thread/notify", threadId: "t1", entry: { state }, line: "L" }, world.deps);
    expect(consumed).toBe(true);
    expect(world.deliveries).toEqual([]);
    expect(world.failures.length).toBe(1);
    expect(world.failures[0]?.error.code).toBe("thread_not_live");
    expect(world.failures[0]?.error.message).toContain(state);
  });

  test("live 态但投递失败（slot 缺席）→ thread_not_live 拒（非 unknown_thread）", () => {
    const failures: Array<{ id: string | undefined; type: string; error: HubErrorShape }> = [];
    const deps = {
      emitFailure: (id: string | undefined, type: string, error: HubErrorShape) => {
        failures.push({ id, type, error });
      },
      deliver: () => false,
    };
    routeLiveOnly({ id: "n2", type: "thread/notify", threadId: "t1", entry: { state: "live" }, line: "L" }, deps);
    expect(failures[0]?.error.code).toBe("thread_not_live");
  });
});

type Emitted = { command: string; success: boolean; error?: { code: string } };

function commandsWorld(status: "idle" | "running") {
  const emitted: Emitted[] = [];
  const calls: Array<{ source: string; kind: string; text: string; target?: string }> = [];
  const rt = {
    state: { handle: { agent: { status, notify: (m: { source: string; kind: string; text: string; target?: string }) => { calls.push(m); } } } },
    bridge: { isStreaming: () => false },
    emitLine: (line: string) => {
      const parsed = JSON.parse(line) as Emitted;
      emitted.push(parsed);
    },
  } as never;
  return { rt, emitted, calls };
}

describe("worker 分派 target 三态（thread/notify handler）", () => {
  test("形状门：source 空 / text 空 / kind 非闭集 → invalid_input 且不触 notify", async () => {
    const { createWorkerCommands } = await import("../worker/worker-commands.ts");
    const world = commandsWorld("idle");
    const handler = createWorkerCommands(world.rt).get("thread/notify");
    expect(handler).toBeDefined();
    for (const input of [
      { id: "a", source: "", kind: "content", text: "x" },
      { id: "b", source: "git-worktree", kind: "content", text: "" },
      { id: "c", source: "git-worktree", kind: "bogus", text: "x" },
    ]) {
      await handler?.(input as never);
    }
    expect(world.emitted.length).toBe(3);
    for (const r of world.emitted) {
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe("invalid_input");
    }
    expect(world.calls).toEqual([]);
  });

  test("idle → target=next-turn（排队不唤醒）；running → next-step（追在飞轮）", async () => {
    const { createWorkerCommands } = await import("../worker/worker-commands.ts");
    const idle = commandsWorld("idle");
    const running = commandsWorld("running");
    await createWorkerCommands(idle.rt).get("thread/notify")?.({ id: "a", source: "git-worktree", kind: "content", text: "T" } as never);
    await createWorkerCommands(running.rt).get("thread/notify")?.({ id: "b", source: "git-worktree", kind: "content", text: "T" } as never);
    expect(idle.calls[0]?.target).toBe("next-turn");
    expect(running.calls[0]?.target).toBe("next-step");
    expect(idle.emitted[0]?.success).toBe(true);
    expect(running.emitted[0]?.success).toBe(true);
  });

  test("无会话（handle 缺席）→ invalid_input", async () => {
    const { createWorkerCommands } = await import("../worker/worker-commands.ts");
    const emitted: Emitted[] = [];
    const rt = { state: {}, bridge: { isStreaming: () => false }, emitLine: (line: string) => { emitted.push(JSON.parse(line) as Emitted); } } as never;
    await createWorkerCommands(rt).get("thread/notify")?.({ id: "a", source: "s", kind: "content", text: "t" } as never);
    expect(emitted[0]?.success).toBe(false);
    expect(emitted[0]?.error?.code).toBe("invalid_input");
  });
});
