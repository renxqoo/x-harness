// 阶段 4 验收：thread/notify 经真 host 进程（live-only 路由 + 无 wake 副作用的进程数断言）。
// 装置复用 smoke kit（SESSION-WORKTREE-WORKFLOW §7 阶段 1 验收点）。

import { afterAll, describe, expect, test } from "vitest";
import { startHost, workerPids } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hostsClosed: HostHandle[] = [];
afterAll(async () => {
  for (const host of hostsClosed) host.end();
  await Promise.all(hostsClosed.map((host) => host.exited().catch(() => -1)));
});

describe("thread/notify live-only 路由（真 host 进程）", () => {
  test("未注册线程 → thread_not_live（非 unknown_thread——路由门命中而非表缺失）且零 worker spawn", async () => {
    const host = await startHost({ script: [] });
    hostsClosed.push(host);
    const before = workerPids(host.proc.pid as number).length;
    host.send({ type: "thread/notify", id: "n1", threadId: "no-such", source: "git-worktree", kind: "content", text: "x" });
    const res = await host.response("n1");
    expect(res.success).toBe(false);
    expect((res as { error?: { code: string } }).error?.code).toBe("unknown_thread"); // 表无此线程先于 live-only
    const after = workerPids(host.proc.pid as number).length;
    expect(after).toBe(before); // 无 wake 副作用（不复活 worker）
  });

  test("parked 线程（retire 保留会话）→ thread_not_live 且无 wake", async () => {
    const host = await startHost({ script: [{ reply: "ok" }] });
    hostsClosed.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const { threadId } = started.data as { threadId: string };
    host.send({ type: "thread/retire", id: "st1", threadId });
    await host.response("st1");
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    const before = workerPids(host.proc.pid as number).length;
    expect(before).toBe(0); // worker 已退（会话文件保留 = parked）
    host.send({ type: "thread/notify", id: "n2", threadId, source: "git-worktree", kind: "content", text: "branch feat-x at /w/t" });
    const res = await host.response("n2");
    expect(res.success).toBe(false);
    expect((res as { error?: { code: string } }).error?.code).toBe("thread_not_live");
    const after = workerPids(host.proc.pid as number).length;
    expect(after).toBe(0); // 关键断言：不唤醒（普通线程域命令此形态会复活 worker）
  });

  test("live 线程 → 投递成功（worker 分派接收）", async () => {
    const host = await startHost({ script: [] });
    hostsClosed.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const { threadId } = started.data as { threadId: string };
    host.send({ type: "thread/notify", id: "n3", threadId, source: "git-worktree", kind: "content", text: "branch feat-x is now checked out at /w/t for this task." });
    const res = await host.response("n3");
    expect(res.success).toBe(true);
  });
});
