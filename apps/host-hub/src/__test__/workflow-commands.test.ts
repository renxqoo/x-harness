import { describe, expect, test } from "vitest";
import { createWorkflowHandlers } from "../worker/workflow-commands.ts";

function makeDeps(world: unknown) {
  const frames: Array<{ command: string; error?: unknown; data?: unknown }> = [];
  return {
    deps: {
      rt: { state: { world } },
      respond: (frame: { command: string; error?: unknown; data?: unknown }) => { frames.push(frame); },
      requireThread: () => ({ id: "sess-1" as never }),
    },
    frames,
  };
}

describe("workflow 命令面", () => {
  test("submit 缺装配 → unknown_command（workflowKit 未装时如实拒）", async () => {
    const { deps, frames } = makeDeps(undefined);
    const handlers = createWorkflowHandlers(deps);
    const submit = handlers.find(([n]) => n === "workflow/submit")?.[1];
    if (submit === undefined) throw new Error("handler missing");
    await submit({ id: "1" });
    expect(frames[0]?.command).toBe("workflow/submit");
    expect(String((frames[0]?.error as { message?: string })?.message ?? "")).toContain("not assembled");
  });

  test("stop 缺 taskId → invalid_input", async () => {
    const { deps, frames } = makeDeps(undefined);
    const handlers = createWorkflowHandlers(deps);
    const stop = handlers.find(([n]) => n === "workflow/stop")?.[1];
    if (stop === undefined) throw new Error("handler missing");
    await stop({ id: "2" });
    expect(frames[0]?.command).toBe("workflow/stop");
    expect((frames[0]?.error as { code?: string })?.code).toBe("invalid_input");
  });

  test("list：空根 → 空 runs（不炸）", async () => {
    const { deps, frames } = makeDeps(undefined);
    const handlers = createWorkflowHandlers(deps);
    const list = handlers.find(([n]) => n === "workflow/list")?.[1];
    if (list === undefined) throw new Error("handler missing");
    await list({ id: "3" });
    expect(frames[0]?.command).toBe("workflow/list");
    expect((frames[0]?.data as { runs: unknown[] })?.runs).toEqual([]);
  });

  test("三命令名齐全", () => {
    const { deps } = makeDeps(undefined);
    const names = createWorkflowHandlers(deps).map(([n]) => n);
    expect(names).toEqual(["workflow/list", "workflow/submit", "workflow/stop"]);
  });
});

describe("workflow 命令面（world 在场路径）", () => {
  function makeWorldCtx(provides: Readonly<Record<string, unknown>>): unknown {
    const map = new Map<string, unknown>(Object.entries(provides));
    return {
      ctx: {
        tryUse: ((token: { readonly name?: string }) => (token.name !== undefined ? map.get(token.name) : undefined)) as import("@x-harness/core").Context["tryUse"],
      },
    };
  }

  test("submit：view.submit 成功 → data.text 回传；参数构造（description/prompt/verifyCommand）", async () => {
    const calls: unknown[] = [];
    const view = {
      submit: async (caller: unknown, input: unknown) => {
        calls.push({ caller, input });
        return { ok: true, text: "Spawned agent-abc12345 (session s1)\n[workflow] taskId: t-r1" };
      },
    };
    const { deps, frames } = makeDeps(makeWorldCtx({ "workflow/view": { ...view }, "tool-registry": undefined }));
    const handlers = createWorkflowHandlers(deps);
    const submit = handlers.find(([n]) => n === "workflow/submit")?.[1];
    if (submit === undefined) throw new Error("missing");
    await submit({ id: "9", description: "修复登录", prompt: "fix it", verifyCommand: "bun test auth" });
    expect(frames[0]?.command).toBe("workflow/submit");
    expect((frames[0]?.data as { text?: string } | undefined)?.text).toContain("taskId: t-r1");
    const call = calls[0] as { caller: string; input: { description: string; acceptance?: { command: string } } };
    expect(call.input.description).toBe("修复登录");
    expect(call.input.acceptance?.command).toBe("bun test auth");
  });

  test("submit：坏 schema JSON → invalid_input（safeJson 错误面）", async () => {
    const view = { submit: async () => ({ ok: true, text: "x" }) };
    const { deps, frames } = makeDeps(makeWorldCtx({ "workflow/view": { ...view }, "tool-registry": undefined }));
    const handlers = createWorkflowHandlers(deps);
    const submit = handlers.find(([n]) => n === "workflow/submit")?.[1];
    if (submit === undefined) throw new Error("missing");
    await submit({ id: "10", description: "d", prompt: "p", resultSchema: "{not-json" });
    expect((frames[0]?.error as { code?: string })?.code).toBe("invalid_input");
  });

  test("stop：registry dispatch 成功/失败双面", async () => {
    const registry = {
      dispatch: async (req: { args: { task_id: string } }) => req.args.task_id === "t-good"
        ? { content: "stopped t-good (run settled: cancelled)" }
        : { isError: true, content: "not-found:t-x" },
    };
    const { deps, frames } = makeDeps(makeWorldCtx({ "workflow/view": undefined, "tool-registry": { ...registry } }));
    const handlers = createWorkflowHandlers(deps);
    const stop = handlers.find(([n]) => n === "workflow/stop")?.[1];
    if (stop === undefined) throw new Error("missing");
    await stop({ id: "11", taskId: "t-good" });
    expect((frames[0]?.data as { text?: string } | undefined)?.text).toContain("cancelled");
    await stop({ id: "12", taskId: "t-x" });
    expect((frames[1]?.error as { code?: string })?.code).toBe("invalid_input");
  });

  test("stop：registry 缺席 → unknown_command", async () => {
    const { deps, frames } = makeDeps(makeWorldCtx({}));
    const handlers = createWorkflowHandlers(deps);
    const stop = handlers.find(([n]) => n === "workflow/stop")?.[1];
    if (stop === undefined) throw new Error("missing");
    await stop({ id: "13", taskId: "t-1" });
    expect(String((frames[0]?.error as { message?: string } | undefined)?.message)).toContain("registry unavailable");
  });
});
