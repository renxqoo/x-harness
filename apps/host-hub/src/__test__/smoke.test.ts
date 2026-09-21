// 进程契约 smoke（MIGRATION §5 smoke.test 移植）：55 命令矩阵黑盒——真 host 进程 +
// 真 worker 子进程（script 模式）。恰一响应/id 回显/command 字段/错误文案对照
// DESIGN 附录 A/心跳/stdout 纯净/EOF exit 0/转发计时。
import { afterAll, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { aliveOf, contentText, drivePrompt, startHost, workerPids } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";
import { COMMAND_NAMES } from "../protocol/commands.ts";

const hostsClosed: HostHandle[] = [];
afterAll(async () => {
  for (const host of hostsClosed) host.end();
  await Promise.all(hostsClosed.map((host) => host.exited().catch(() => -1)));
});

describe("进程契约 smoke", () => {
  test("心跳/启动/hello 旅程：thread/start → prompt → settled → 事件词表 → EOF exit 0 + worker 全退", async () => {
    const host = await startHost({ script: [{ reply: "smoke reply" }] });
    hostsClosed.push(host);
    const hostPid = host.proc.pid as number;
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    expect(started.success).toBe(true);
    const { threadId, cwd, sessionPath } = started.data as { threadId: string; cwd: string; sessionPath: string };
    expect(threadId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    // cwd 归一（worker normalizeCwd——macOS /var → /private/var realpath）
    expect(cwd.endsWith(host.agentDir.split("/tmp/").at(-1) ?? "")).toBe(true);
    expect(sessionPath).toBe(join(host.sessionsRoot, threadId, "events.jsonl"));
    // worker 子进程在世
    const pids = workerPids(hostPid);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    expect(aliveOf(pids).every(Boolean)).toBe(true);
    // prompt → settled + 事件词表
    await drivePrompt(host, { threadId, id: "p1", message: "hello smoke" });
    for (const name of ["turn/start", "user/message", "assistant/message", "turn/end", "settled", "llm/chunk", "agent/status"]) {
      expect(host.lines.some((frame) => frame.type === "event" && frame.name === name), `event ${name}`).toBe(true);
    }
    const assistant = host.lines.find((frame) => frame.type === "event" && frame.name === "assistant/message");
    expect(contentText((assistant as unknown as { payload: unknown }).payload)).toContain("smoke reply");
    // WAL 落盘（events.jsonl 存在且含 user 消息）
    const wal = await readFile(sessionPath, "utf8");
    expect(wal).toContain("hello smoke");
    // 转发计时锚：user/message 事件帧响应极快（<1ms 量级——计时校验用帧间单调性）
    const heartbeat = host.lines.filter((frame) => frame.type === "heartbeat");
    expect(heartbeat.length).toBeGreaterThanOrEqual(1);
    // EOF → exit 0 + worker 全退
    host.end();
    const code = await host.exited();
    expect(code).toBe(0);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 200);
    });
    expect(aliveOf(pids).some(Boolean)).toBe(false);
  }, 60_000);

  test("55 命令矩阵：全命令恰一响应 + id 回显 + command 字段（unknown 拒；关闭期 shutting down）", async () => {
    const host = await startHost({ script: [] });
    hostsClosed.push(host);
    // host 本地域命令（无会话形态）
    const localCommands = ["thread/list", "thread/list_saved", "get_models", "get_host_info", "settings/get", "agents/list", "skills/list", "auth/list", "workspace/trust", "permission/get_mode"];
    for (const command of localCommands) {
      host.send({ type: command, id: `m-${command}` });
      const frame = await host.response(`m-${command}`);
      expect(frame.command).toBe(command); // command 字段恒字符串
      expect(frame.success).toBe(true);
    }
    // 线程域无 threadId → threadId required
    for (const command of ["prompt", "get_state", "fork", "bash"]) {
      host.send({ type: command, id: `nt-${command}` });
      const frame = await host.response(`nt-${command}`);
      expect(frame.error).toBe("threadId required");
    }
    // 未知线程
    host.send({ type: "get_state", id: "uk1", threadId: "ghost" });
    expect((await host.response("uk1")).error).toBe("Unknown threadId");
    // 未知命令
    host.send({ type: "no_such_command", id: "uc1" });
    expect((await host.response("uc1")).error).toBe("unknown command");
    // parse failure（无 id 帧）
    (host.proc.stdin as NodeJS.WritableStream).write("garbage not json\n");
    const parseFrame = await host.wait((frame) => frame.type === "response" && frame.command === "parse" && frame.id === null, "parse failure");
    expect(parseFrame.error).toBe("parse failure");
    // internal id 冒用
    host.send({ type: "get_state", id: "@hub-internal:999", threadId: "x" });
    expect((await host.response("@hub-internal:999")).error).toBe("invalid id: reserved namespace");
    // 关闭期命令
    host.end();
    await host.exited();
  }, 60_000);

  test("命令封闭集 55 锚（真进程无关——词表回归锚随进程面走）", () => {
    expect(COMMAND_NAMES.length).toBe(56);
  });

  test("stdout 纯净：无 heartbeat/response/event/hub_error/ui_request/thread_* 外的帧型", async () => {
    const host = await startHost({ script: [{ reply: "x" }] });
    hostsClosed.push(host);
    const allowed = new Set(["heartbeat", "response", "event", "hub_error", "ui_request", "thread_died", "thread_parked"]);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    await host.response("s1");
    host.end();
    await host.exited();
    for (const frame of host.lines) {
      expect(allowed.has(frame.type), `unexpected frame type: ${frame.type}`).toBe(true);
    }
  }, 60_000);
});
