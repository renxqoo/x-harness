// bash 完成通知臂测试（docs/TASK-PUSH-DESIGN.md §2.4/§4）：铸文（首行/bytes/路径/帽与
// 写失败注记/尾部）、readTail（小文件全文/大文件尾部帽/UTF-8 边界/读失败空串）、
// listener 丢弃面（匿名/句柄缺席/notify throw 留痕）+ 真装配集成（scripted LLM 驱动
// 真后台任务 → [task-notification] 材料化为 agent/message{source:bash-task} 且唤醒）。

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import type { SessionId } from "@x-harness/session";
import type { TaskSnapshot } from "@x-harness/tool-bash";
import type { AgentLoopService } from "@x-harness/agent-loop";
import { BASH_TASK_NOTIFY_SOURCE, createBashTaskNotifier, readTail, taskNotificationText } from "../notify-bash.ts";

const sid = (v: string): SessionId => v as SessionId;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-notify-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: "t-aa11bb22cc33",
  command: "echo hi",
  state: "completed",
  exitCode: 0,
  startedAt: 1,
  endedAt: 2,
  session: sid("s1"),
  logPath: "/tmp/logs/s1/bash-task-t-aa11bb22cc33.log",
  bytes: 3,
  droppedBytes: 0,
  truncated: false,
  writeError: undefined,
  ...over,
});

describe("taskNotificationText 铸文", () => {
  it("首行与 stop 回执 stateLine 同口径 + log 路径行 + 尾部切片", () => {
    const text = taskNotificationText(snap(), "hi\n");
    expect(text).toContain("[task-notification] task t-aa11bb22cc33 (echo hi): completed exit=0 bytes=3");
    expect(text).toContain("log: /tmp/logs/s1/bash-task-t-aa11bb22cc33.log");
    expect(text).toContain("hi\n");
  });

  it("写帽任务带 dropped 注记；写失败任务带 incomplete 注记", () => {
    expect(taskNotificationText(snap({ truncated: true, droppedBytes: 4096 }), "")).toContain("(output hit the write cap; 4096 bytes dropped");
    expect(taskNotificationText(snap({ writeError: "EIO" }), "")).toContain("log incomplete (write error: EIO)");
  });

  it("command 超长按码点截 80（emoji 不产生孤立代理项）", () => {
    const long = `${"😀".repeat(50)}${"y".repeat(60)}`; // 110 码点 > 80
    const text = taskNotificationText(snap({ command: long }), "");
    expect(text).toContain(`(${"😀".repeat(50)}${"y".repeat(30)}…)`); // 截 80 码点 + 省略号
  });
});

describe("readTail", () => {
  it("小文件（< 帽）返回全文", async () => {
    const path = join(root, "small.log");
    writeFileSync(path, "tiny-output");
    expect(await readTail(path, 4_096)).toBe("tiny-output");
  });

  it("大文件返回尾部帽内切片（不整读）", async () => {
    const path = join(root, "big.log");
    writeFileSync(path, `${"x".repeat(10_000)}TAIL`);
    expect(await readTail(path, 100)).toBe(`${"x".repeat(96)}TAIL`); // 帽 100 字节 = 96x + TAIL(4)
  });

  it("帽边界劈在多字节字符中间——首部续字节回退到字符边界（残半字符丢弃，不劈字）", async () => {
    const path = join(root, "utf8.log");
    writeFileSync(path, `${"a".repeat(100)}😀尾部`); // 😀 占 [100,104)、尾 [104,107)、部 [107,110)
    const tail = await readTail(path, 8); // start0 = 102——落在 😀 的第 3 字节（续字节）
    expect(tail).toBe("尾部"); // 残缺 😀 后半丢弃，从「尾」字符边界起
    expect(tail.startsWith("\uFFFD")).toBe(false);
  });

  it("读失败（文件缺席）返回空串——通知仍发，路径行即指针", async () => {
    expect(await readTail(join(root, "absent.log"), 4_096)).toBe("");
  });
});

describe("createBashTaskNotifier 丢弃面（单元）", () => {
  it("匿名会话（session undefined）不查 loop 直接丢弃", async () => {
    const calls: string[] = [];
    const loop = { get: () => ({ agent: { notify: (source: string) => calls.push(source) } }) } as never as AgentLoopService;
    createBashTaskNotifier({ loop })(snap({ session: undefined }));
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(calls).toEqual([]);
  });

  it("句柄缺席（已封存/evict 竞态）丢弃不抛", async () => {
    const loop = { get: () => undefined } as never as AgentLoopService;
    createBashTaskNotifier({ loop })(snap());
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    }); // 到达此处即未抛
  });

  it("notify throw（父恰在封存）→ onWarn 留痕不外抛", async () => {
    const warnings: string[] = [];
    const loop = { get: () => ({ agent: { notify: () => { throw new Error("sealing"); } } }) } as never as AgentLoopService;
    createBashTaskNotifier({ loop, onWarn: (message) => warnings.push(message) })(snap({ logPath: join(root, "x.log") }));
    const dropped = (): boolean => warnings.some((message) => message.includes("notify dropped"));
    await vi.waitFor(() => expect(dropped()).toBe(true), { timeout: 2_000 });
  });
});

describe("真装配集成：后台任务完成 → [task-notification] 唤醒亲会话", () => {
  it("run_in_background 完成 → agent/message{source:bash-task} 落 WAL 且含尾部与日志路径", async () => {
    const { createContext, loadPlugins } = await import("@x-harness/core");
    const { sessionPlugin } = await import("@x-harness/session");
    const { toolsPlugin } = await import("@x-harness/tools");
    const { llmPlugin, llmRuntime } = await import("@x-harness/llm");
    const { agentLoopPlugin, agentLoopServiceToken } = await import("@x-harness/agent-loop");
    const { scriptedAdapter, textScript } = await import("@x-harness/testkit");
    const { createBashPlugin } = await import("@x-harness/tool-bash");
        const { createTaskToolsPlugin } = await import("../plugin.ts");
    const logRoot = mkdtempSync(join(tmpdir(), "xh-notify-e2e-"));
    try {
      const scripts: Array<AsyncGenerator<LlmChunk>> = [];
      const ctx = createContext();
      await loadPlugins(ctx, [
        sessionPlugin,
        (await import("@x-harness/system-prompt")).systemPromptPlugin,
        (await import("@x-harness/exec-env")).createLocalEnvPlugin(),
        toolsPlugin,
        createBashPlugin({ taskLimits: { taskLogDir: logRoot } }),
        createTaskToolsPlugin(),
        llmPlugin,
        agentLoopPlugin,
      ]);
      ctx.use(llmRuntime).registerAdapter(scriptedAdapter({ scripts, exhausted: "(exhausted)" }));
      const made = await ctx.use(agentLoopServiceToken).create({
        session: { id: sid("notify-e2e") },
        agent: { model: "fake-model", provider: "fake" },
      });
      expect(made.ok).toBe(true);
      if (!made.ok) throw new Error(made.reason);
      const agent = made.value.agent;
      scripts.push(
        (async function* (): AsyncGenerator<LlmChunk> {
          yield { type: "tool-call-delta", index: 0, callId: "tc-bg", name: "bash", argumentsDelta: JSON.stringify({ command: "echo notify-needle", run_in_background: true }) };
          yield { type: "finish", finish: { kind: "stop" } };
        })(),
        textScript("noted the notification"), // 通知唤醒后的收尾轮
      );
      // 送达路径两路皆可（busy 亲会话步边界消费 / idle 唤醒新轮）——断言面是 WAL 的
      // agent/message{source:bash-task} 帧：材料化只发生在真实消费的领取步，两路殊途同归
      agent.followup("start a background task");
      await agent.whenIdle(); // 首轮（起任务）收轮
      // 通知链：settle → onSettled → tail 读 → notify → 唤醒新轮 → 材料化 agent/message 落 WAL
      const hasNotice = (): boolean => agent.session.events().some((e) => e.type === "agent/message" && JSON.stringify(e.data).includes(BASH_TASK_NOTIFY_SOURCE));
      await vi.waitFor(() => expect(hasNotice()).toBe(true), { timeout: 5_000 });
      const frame = JSON.stringify(agent.session.events().filter((e) => e.type === "agent/message").at(-1)?.data);
      expect(frame).toContain("[task-notification]");
      expect(frame).toContain("completed exit=0");
      expect(frame).toContain("notify-needle"); // 尾部切片带到证据
      const logLine = frame.match(/log: ([^"\\]+)/)?.[0] ?? "";
      expect(logLine).not.toBe("");
      expect(readFileSync(logLine.replace("log: ", ""), "utf8")).toBe("notify-needle\n");
      await agent.whenIdle(); // 收尾轮（消耗第二脚本）
      await made.value.dispose();
      await ctx.dispose();
    } finally {
      rmSync(logRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
