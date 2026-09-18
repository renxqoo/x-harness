// e2e：子代理旅程（docs/AGENT-DELEGATION.md §4）——独立装配不动既有 assembleWorld：
// 假适配器按 request.model 分桶路由；父模型调 agent_spawn → 子模型完成 → 父第二 turn 消费通知；
// 断言父子两会话 jsonl 落盘。
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { must } from "./check.ts";

const PARENT_MODEL = "e2e-parent-model";
const CHILD_MODEL = "e2e-child-model";

export async function runDelegationJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xh-delegation-"));
  try {
    const ctx = createContext();
    const scripts = new Map<string, Array<AsyncGenerator<LlmChunk>>>();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      createJsonlSessionPersistence({ root }),
      toolsPlugin,
      llmPlugin,
      systemPromptPlugin,
      agentLoopPlugin,
      createAgentDelegationPlugin({ types: { worker: { model: CHILD_MODEL, prompt: "you are the worker" } } }),
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
        return bucket.shift() as AsyncGenerator<LlmChunk>;
      },
    });
    ctx.effect(off);

    const text = (model: string, body: string): AsyncGenerator<LlmChunk> =>
      (async function* (): AsyncGenerator<LlmChunk> {
        void model;
        yield { type: "text-delta", text: body };
        yield { type: "finish", finish: { kind: "stop" } };
      })();

    // 父脚本：第一轮发起 agent_spawn 工具调用；第二轮消费通知后收尾。子脚本：完成任务回报。
    scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield {
          type: "tool-call-delta",
          index: 0,
          callId: "e2e-spawn",
          name: "agent_spawn",
          argumentsDelta: JSON.stringify({ prompt: "count to three", type: "worker" }),
        };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      text(PARENT_MODEL, "notification received, wrapping up"),
    ]);
    scripts.set(CHILD_MODEL, [text(CHILD_MODEL, "worker finished: one two three")]);

    const loop = ctx.use(agentLoopServiceToken);
    const made = await loop.create({ session: { id: "delegation-parent" as SessionId }, agent: { model: PARENT_MODEL, provider: "fake" } });
    must(made.ok, `父 agent 创建（实际：${made.ok === false ? made.reason : "ok"}）`);
    if (!made.ok) return;
    made.value.agent.followup("delegate the counting");
    await made.value.agent.whenIdle();

    // ① 通知进入父上下文并被子消化（两条合法路径：父 idle → 唤醒第二 turn；父 busy → 步边界续航）
    const parentEvents = made.value.agent.session.events();
    const userTexts = parentEvents
      .filter((e) => e.type === "user/message")
      .map((e) => JSON.stringify(e.data))
      .join("\n");
    must(userTexts.includes("[agent-notification]"), "通知文本进入父上下文");
    must(userTexts.includes("completed"), "通知携带子完成状态");
    must(userTexts.includes("one two three"), "通知携带子报告摘要");
    const finalAssistant = JSON.stringify(parentEvents.filter((e) => e.type === "assistant/message").at(-1)?.data);
    must(finalAssistant.includes("notification received, wrapping up"), "父消化通知后收尾（第二脚本被消费）");

    // ② 子会话存在且完整落盘（spawn 文案中的 sessionId 寻址）
    const listTool = await ctx.use(toolRegistry).dispatch({
      callId: "e2e-list",
      name: "list_agents",
      args: {},
      signal: new AbortController().signal,
      session: made.value.agent.session.id,
    });
    const childSession = listTool.content.match(/session=([A-Za-z0-9._-]+)/)?.[1];
    must(childSession !== undefined, `list_agents 返回子 sessionId（实际：${listTool.content}）`);
    // 读盘前过 flush 屏障（jsonl 排空是异步队列）
    const store = ctx.use(sessionStore);
    await store.flush(childSession as SessionId);
    await store.flush("delegation-parent" as SessionId);
    const childDisk = readFileSync(join(root, childSession as string, "events.jsonl"), "utf8");
    must(childDisk.includes('"turn/end"') && childDisk.includes('"completed"'), "子会话 jsonl 完整落盘");
    const parentDisk = readFileSync(join(root, "delegation-parent", "events.jsonl"), "utf8");
    must(parentDisk.includes('"tool/call"') && parentDisk.includes("[agent-notification]"), "父会话 jsonl 含 spawn 调用与通知");

    await made.value.dispose();
    await ctx.dispose();
    void unload;
    console.log("子代理旅程：父 spawn → 子完成 → 通知唤醒父消费 → 双会话落盘 通过");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
