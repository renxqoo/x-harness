// e2e：件15 长内容旅程（docs/DELEGATION-LONG-CONTENT.md §3）——reportCap 120 小 cap 驱动
// 截断-追问-文件中转闭环：超长 agent_message schema 拒绝（回显含具体上限数字）→ 子改走
// write 文件 + 短 message 带路径 → 父 WAL 收 <cross-session-message> 含路径 + 文件在盘 →
// 子报告超 cap → 父通知含截断尾注两半句。装配 = delegation-journey 基础上补 write 面
// （createWritePlugin + PathGate/ObservedRegistry/ExecEnv——root 指旅程临时目录）+
// createTaskToolsPlugin（delegation 硬依赖，缺即装配 throw）。
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createWritePlugin } from "@x-harness/tool-write";
import { must } from "./check.ts";

const PARENT_MODEL = "e2e-parent-model";
const CHILD_MODEL = "e2e-child-model";

export async function runLongContentJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-longcontent-"));
  const agentsDir = await mkdtemp(join(tmpdir(), "xh-longcontent-agents-"));
  const ctx = createContext();
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(agentsDir, "worker.md"),
      `---\nname: worker\ndescription: relay worker\nmodel: ${CHILD_MODEL}\n---\nyou are the worker`,
    );
    const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
    const env = createLocalEnv(root);
    const gate = new PathGate(root);
    const observed = new ObservedRegistry();
    await loadPlugins(ctx, [
      sessionPlugin,
      createJsonlSessionPersistence({ root }),
      systemPromptPlugin,
      toolsPlugin,
      createWritePlugin({ gate, observed, env }), // 脚本②文件中转落盘面
      llmPlugin,
      agentLoopPlugin,
      createTaskToolsPlugin(), // delegation 硬依赖（inject 声明）
      createAgentDelegationPlugin({ agentsDirs: [agentsDir], workspaceRoot: process.cwd(), worktreeSweep: false, reportCap: 120 }), // 小 cap：耦合面即测试面
    ]);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: (request: LlmRequest) => {
        const bucket = scripts.get(request.model);
        if (bucket === undefined) {
          return (async function* (): AsyncGenerator<LlmChunk> {
            yield { type: "finish", finish: { kind: "error", message: `no-script-bucket:${request.model}`, code: "test" } };
          })();
        }
        const next = bucket.shift();
        if (next === undefined) {
          return (async function* (): AsyncGenerator<LlmChunk> {
            yield { type: "finish", finish: { kind: "error", message: `bucket-empty:${request.model}`, code: "test" } };
          })();
        }
        return next;
      },
    });
    ctx.effect(off);

    const text = (body: string): AsyncGenerator<LlmChunk> =>
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: body };
        yield { type: "finish", finish: { kind: "stop" } };
      })();
    const call = (callId: string, name: string, args: Record<string, unknown>): AsyncGenerator<LlmChunk> =>
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId, name, argumentsDelta: JSON.stringify(args) };
        yield { type: "finish", finish: { kind: "stop" } };
      })();

    const longMessage = "y".repeat(200); // > 120 reportCap（maxLength 恒等）
    const relayPath = "relay-payload.md";
    // 父脚本：spawn →（子拒绝回显后）父收路径消息 → 收尾。
    scripts.set(PARENT_MODEL, [
      call("e2e-spawn", "agent_spawn", { description: "relay content", prompt: "relay your findings", subagent_type: "worker" }),
      text("path received, done"),
    ]);
    // 子脚本：①超长 message（schema 拒绝——完整合法 JSON 超 maxLength）→ ②write 文件 + 短 message 带路径 → ③终轮报告超 cap。
    scripts.set(CHILD_MODEL, [
      call("c1", "agent_message", { to: "main", message: longMessage }),
      call("c2", "write", { path: relayPath, content: `# relayed\n${longMessage}\n` }),
      call("c3", "agent_message", { to: "main", message: `full content written to ${relayPath}` }),
      text("z".repeat(300)), // 报告 300 > 120 cap → 截断尾注（text 已绑定 CHILD_MODEL 桶）
    ]);

    const loop = ctx.use(agentLoopServiceToken);
    const made = await loop.create({ session: { id: "longcontent-parent" as SessionId }, agent: { model: PARENT_MODEL, provider: "fake" } });
    must(made.ok, "父 agent 创建");
    if (!made.ok) return;
    made.value.agent.followup("delegate the relay");
    await made.value.agent.whenIdle();

    const childEvents = async (): Promise<string> => {
      const listTool = await ctx.use(toolRegistry).dispatch({
        callId: "e2e-list",
        name: "list_agents",
        args: {},
        signal: new AbortController().signal,
        session: made.value.agent.session.id,
      });
      const childSession = listTool.content.match(/session=([A-Za-z0-9._-]+)/)?.[1];
      must(childSession !== undefined, `list_agents 返回子 session（实际：${listTool.content}）`);
      const store = ctx.use((await import("@x-harness/session")).sessionStore);
      await store.flush(childSession as SessionId);
      const disk = readFileSync(join(root, childSession as string, "events.jsonl"), "utf8");
      await made.value.dispose(); // 旅程读盘点：子终态已落盘
      return disk;
    };
    const childDisk = await childEvents();

    // ① schema 拒绝路径：超长 message 拒绝回显含具体上限数字（D4——maxLength 载体直接数字）
    must(childDisk.includes("/message: Expected string length less or equal to 120"), "超长 message 拒绝回显含字段路径与上限数字（审查 A P2-1 前缀锚——防他工具同 cap 巧合）");
    // ② 文件中转：write 落盘 + 短 message 投递成功
    must(existsSync(join(root, relayPath)), "中转文件在盘");
    // ③ 父收路径消息（<cross-session-message> 含路径）
    const parentDisk = readFileSync(join(root, "longcontent-parent", "events.jsonl"), "utf8");
    must(parentDisk.includes(`<cross-session-message from=\\"`) && parentDisk.includes(relayPath), "父 WAL 收到含路径的跨会话消息");
    // ④ 报告超 cap 截断尾注（三段同一通知内共存——审查 A P3-2：防分属不同行巧合通过；
    //    jsonl 中 agent/message 通知与投影引用可致同文本多次落卷，取第一条断言三段共存）
    const notice = (parentDisk.split("\n").find((line) => line.includes("truncated at 120")) ?? "").replace(/\\n/g, "\n");
    must(notice !== "", "截断尾注在场");
    must(notice.includes("use agent_message to ask the agent for specifics"), "尾注含追问半句");
    must(notice.includes("or have it write the full content to a file"), "尾注含文件中转半句");

    await ctx.dispose();
    console.log("长内容旅程：超限拒绝（数字回显）→ 文件中转 → 父收路径 → 截断尾注两半句 通过");
  } finally {
    // must 断言失败也回卷 ctx（jsonl 句柄/级联 cancel/定时器——审查 B#1 泄漏窗口）后再清目录
    await ctx.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(agentsDir, { recursive: true, force: true }).catch(() => {});
  }
}
