import { join } from "node:path";

// 恢复路径挂起用例的手造中断态任务（task-deadline.test 拆出——行数纪律）。

/** 手造中断态任务（journal dispatched + 子会话档案开放轮——恢复 kick 的锚） */
export async function craftInterruptedTask(root: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { openRunJournal, workflowPluginVersion } = await import("../journal.ts");
  const runId = "r-hang-recover";
  const made = await openRunJournal(join(root, "workflows"), { runId, parentSession: "wf-parent", cwd: root, createdAt: 1, pluginVersion: workflowPluginVersion() });
  if (made.kind !== "opened") throw new Error("fixture");
  await made.writer.append([{ type: "run/created", runId, parentSession: "wf-parent", cwd: root }]);
  await made.writer.append([{ type: "task/submitted", taskId: `t-${runId}`, spec: { description: "d", prompt: "p" } }]);
  await made.writer.append([{ type: "task/dispatched", taskId: `t-${runId}`, agentId: "agent-ab12cd34", sessionId: "recover-child" }]);
  await made.writer.close();
  const childDir = join(root, "sessions", "recover-child");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "header.json"), JSON.stringify({ id: "recover-child", parentSession: "wf-parent", createdAt: 1, cwd: root, agentId: "agent-ab12cd34", agentType: "untyped", agentDepth: 1 }));
  await writeFile(join(childDir, "events.jsonl"), [
    JSON.stringify({ type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: "p" }] } }),
    JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
    "",
  ].join("\n"));
}

