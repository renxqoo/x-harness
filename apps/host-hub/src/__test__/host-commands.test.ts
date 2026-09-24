// host 命令面旅程（MIGRATION §5 host-threads/host-relay/host-readhistory-state/
// admin-commands-matrix 移植）：注入 input/emit + 假 spawn 跑真 runHost——
// admission/围栏/register 幂等/设置双级/workspace-trust/models-admin/skills-admin/
// agents-admin/direct-reads/旋钮/host_info 矩阵。
import { EventEmitter } from "node:events";
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHost } from "../host/host.ts";
import type { WorkerSpawnSpec } from "../host/worker-process.ts";
import type { WorkerHandle } from "../host/worker-process.ts";
import { responseLine } from "../shared/frame-classify.ts";

class FakeInput extends EventEmitter {
  private pending: Buffer[] = [];

  constructor() {
    super();
    this.on("newListener", (event: string) => {
      if (event === "data") {
        const backlog = this.pending;
        this.pending = [];
        if (backlog.length > 0) {
          queueMicrotask(() => {
            for (const chunk of backlog) this.emit("data", chunk);
          }); // newListener 先于注册——冲放延后到监听器就位后
        }
      }
    });
  }

  send(cmd: unknown): void {
    const chunk = Buffer.from(`${JSON.stringify(cmd)}\n`, "utf8");
    if (this.listenerCount("data") > 0) this.emit("data", chunk);
    else this.pending.push(chunk); // 装配完成前到达——挂监听即冲放
  }
}

interface FakeWorker {
  written: string[];
  onLine: (line: string) => void;
  hello: () => void;
  close: () => void;
}

interface HostFixture {
  input: FakeInput;
  client: string[];
  agentDir: string;
  sessionsRoot: string;
  /** 隔离 HOME（skills/agents 管理面的 user 目录根） */
  home: string;
  workers: FakeWorker[];
  send(cmd: unknown): void;
}

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFrame(client: readonly string[], pred: (frame: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    for (const line of client) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (pred(frame)) return frame;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`waitFrame timeout; last: ${client.slice(-4).join(" | ")}`);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 10);
    });
  }
}

/** response error 字段结构化断言面（code + message） */
function errOf(frame: Record<string, unknown>): { code: string; message: string } {
  return frame["error"] as { code: string; message: string };
}

async function waitResponse(client: readonly string[], command: string, id?: string): Promise<Record<string, unknown>> {
  return waitFrame(client, (frame) => frame["type"] === "response" && frame["command"] === command && (id === undefined || frame["id"] === id));
}

/** 真 runHost + 假 worker spawn（hello/控制响应手驱）+ emit 收帧 */
async function startHost(env: Record<string, string | undefined> = {}): Promise<HostFixture> {
  const agentDir = await tempDir("hub-host-");
  const sessionsRoot = join(agentDir, "sessions");
  const home = await tempDir("hub-home-");
  const input = new FakeInput();
  const client: string[] = [];
  const workers: FakeWorker[] = [];
  void runHost({
    homeDir: home,
    agentDir,
    sessionsRoot,
    env,
    input: input as unknown as NodeJS.ReadStream,
    exit: () => {},
    emitOverride: (line) => client.push(line),
    spawn: (spec: WorkerSpawnSpec): WorkerHandle => {
      const worker: FakeWorker = {
        written: [],
        onLine: spec.onLine,
        hello: () => spec.onLine(`{"type":"hello","protocolVersion":1,"backendId":"x-harness"}`),
        close: () => spec.onClosed(),
      };
      workers.push(worker);
      return {
        uid: `fake-${workers.length}`,
        write: (line: string) => {
          worker.written.push(line);
          return Promise.resolve();
        },
        kill: () => {
          setTimeout(() => spec.onClosed(), 0);
        },
        eof: () => {
          setTimeout(() => spec.onClosed(), 0);
        },
        exited: new Promise<void>(() => {}),
      };
    },
  });
  return { input, client, agentDir, sessionsRoot, home, workers, send: (cmd) => input.send(cmd) };
}

/** thread/start 手驱：spawn → hello → 控制应答（表落实） */
async function driveStart(f: HostFixture, id: string, cwd = "/w"): Promise<string> {
  f.send({ type: "thread/start", id, cwd });
  await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
  const worker = f.workers[f.workers.length - 1];
  worker?.hello();
  await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
  const startLine = worker?.written.find((line) => line.includes('"thread/start"'));
  const threadId = `t-${id}`;
  worker?.onLine(responseLine({ id, command: "thread/start", success: true, data: { threadId, cwd, sessionPath: `${f.sessionsRoot}/${threadId}/events.jsonl` } }));
  void startLine;
  return threadId;
}

describe("host 本地命令（注入 IO）", () => {
  test("get_host_info / thread/list / 旋钮 clamp / parse failure / unknown command / ui_response 恒 ack", async () => {
    const f = await startHost();
    f.send({ type: "get_host_info", id: "h1" });
    const info = await waitResponse(f.client, "get_host_info", "h1");
    const data = info["data"] as { version: string; threads: { live: number }; limits: Record<string, number> };
    expect(data.threads.live).toBe(0);
    expect(data.limits.maxThreads).toBe(32);
    f.send({ type: "set_idle_retire_ms", id: "k1", value: 1 });
    const clamped = await waitResponse(f.client, "set_idle_retire_ms", "k1");
    expect((clamped["data"] as { value: number }).value).toBe(1_000); // clamp 下限
    f.send({ type: "set_rss_retire_bytes", id: "k2", value: -5 });
    const badRss = await waitResponse(f.client, "set_rss_retire_bytes", "k2");
    expect(errOf(badRss).code).toBe("invalid_input");
    f.input.emit("data", Buffer.from("not json\n", "utf8")); // 裸行——不经 JSON.stringify
    const parse = await waitResponse(f.client, "parse");
    expect(errOf(parse)).toEqual({ code: "protocol", message: "parse failure" });
    f.send({ type: "no_such_command", id: "u1" });
    const unknown = await waitResponse(f.client, "no_such_command", "u1");
    expect(errOf(unknown)).toEqual({ code: "unknown_command", message: "unknown command" });
    f.send({ type: "ui_response", id: "ur1", requestId: "none", payload: { confirmed: true } });
    const ack = await waitResponse(f.client, "ui_response", "ur1");
    expect(ack["success"]).toBe(true);
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    expect(list["data"]).toEqual([]);
  });

  test("thread/start 准入 + 控制应答落实表 + thread/list 投影 + stop 结算", async () => {
    const f = await startHost({ HUB_MAX_THREADS: "1" });
    const t1 = await driveStart(f, "s1");
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    const rows = list["data"] as Array<{ threadId: string; state: string }>;
    expect(rows.some((row) => row.threadId === t1 && row.state === "live")).toBe(true);
    // 预算满：第二个 start 拒
    f.send({ type: "thread/start", id: "s2" });
    const rejected = await waitResponse(f.client, "thread/start", "s2");
    expect(errOf(rejected)).toEqual({ code: "thread_limit", message: "too many live threads (limit reached)" });
    // stop：幂等 ack
    f.send({ type: "thread/stop", id: "sp1", threadId: t1 });
    const stopped = await waitResponse(f.client, "thread/stop", "sp1");
    expect(stopped["success"]).toBe(true);
  });

  test("thread/resume 围栏（相对路径/逃逸/不存在）+ register 幂等 + parked 直读接管", async () => {
    const f = await startHost();
    f.send({ type: "thread/resume", id: "r1", sessionPath: "relative/path/events.jsonl" });
    const relative = await waitResponse(f.client, "thread/resume", "r1");
    expect(errOf(relative).code).toBe("path_forbidden");
    f.send({ type: "thread/resume", id: "r2", sessionPath: `${f.sessionsRoot}/nope/events.jsonl` });
    const missing = await waitResponse(f.client, "thread/resume", "r2");
    expect(errOf(missing)).toEqual({ code: "session_unreadable", message: "Session file not readable" });
    // 真档案：register → parked 表项；再 register 幂等；get_state parked 直读
    const sid = "regsession01";
    const dir = join(f.sessionsRoot, sid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd: "/proj" }), "utf8");
    const events = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
      { type: "user/message", seq: 1, time: 2, data: { turn: 0, step: 0, content: [{ type: "text", text: "hello saved" }] }, surfaceOp: "append" },
      { type: "assistant/message", seq: 2, time: 3, data: { turn: 0, step: 0, content: [{ type: "text", text: "hi" }] }, surfaceOp: "append" },
      { type: "session/meta", seq: 3, time: 4, data: { key: "title", value: "saved thread" } },
      { type: "turn/end", seq: 4, time: 5, data: { turn: 0, reason: { kind: "completed" } } },
    ];
    await writeFile(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    f.send({ type: "thread/register", id: "rg1", sessionPath: join(dir, "events.jsonl") });
    const registered = await waitResponse(f.client, "thread/register", "rg1");
    expect(registered["data"]).toEqual({ threadId: sid, cwd: "/proj", sessionPath: join(dir, "events.jsonl") });
    // 幂等：再 register 同路径 → 同 data
    f.send({ type: "thread/register", id: "rg2", sessionPath: join(dir, "events.jsonl") });
    const again = await waitResponse(f.client, "thread/register", "rg2");
    expect(again["data"]).toEqual(registered["data"]);
    // parked get_state 直读（免唤醒——零 spawn 增量）
    const spawnCount = f.workers.length;
    f.send({ type: "get_state", id: "gs1", threadId: sid });
    const state = await waitResponse(f.client, "get_state", "gs1");
    const sd = state["data"] as { sessionName: string; messageCount: number; sessionId: string; queue: { steering: Array<{ id: string; text: string }>; followUp: Array<{ id: string; text: string }> } };
    expect(sd.sessionName).toBe("saved thread");
    expect(sd.messageCount).toBe(2);
    expect(sd.sessionId).toBe(sid);
    expect(sd.queue).toEqual({ steering: [], followUp: [] });
    expect(f.workers.length).toBe(spawnCount); // 直读免唤醒
    // get_entries 直读（游标 + 0 基 leafSeq）
    f.send({ type: "get_entries", id: "ge1", threadId: sid, since: 1, limit: 2 });
    const entries = await waitResponse(f.client, "get_entries", "ge1");
    const ed = entries["data"] as { entries: Array<{ seq: number }>; leafSeq: number; hasMore: boolean };
    expect(ed.leafSeq).toBe(4);
    expect(ed.entries.map((e) => e.seq)).toEqual([3, 4]); // since=1 排他 → [2,3,4]；limit 2 取最近 → [3,4]
    expect(ed.hasMore).toBe(true);
    // 收敛读空形态
    f.send({ type: "get_inflight", id: "gi1", threadId: sid });
    const inflight = await waitResponse(f.client, "get_inflight", "gi1");
    expect(inflight["data"]).toEqual({ turnStartSeq: null, turnStartedAt: null, message: null, toolOutputs: [], bash: null });
  });

  test("workspace/trust 三形态 + settings 双级门禁 + set 白名单", async () => {
    const f = await startHost();
    f.send({ type: "workspace/trust", id: "wt0" });
    const emptyList = await waitResponse(f.client, "workspace/trust", "wt0");
    expect(emptyList["data"]).toEqual({ trusted: [] });
    f.send({ type: "workspace/trust", id: "wt1", cwd: "/definitely/missing/../path", trusted: true });
    await waitResponse(f.client, "workspace/trust", "wt1");
    f.send({ type: "workspace/trust", id: "wt2" });
    const listed = await waitResponse(f.client, "workspace/trust", "wt2");
    expect((listed["data"] as { trusted: string[] }).trusted).toContain("/definitely/path");
    // 未信任 cwd 的 settings/get{cwd} → 拒（带出路文案）
    f.send({ type: "settings/get", id: "sg1", cwd: "/untrusted" });
    const gate = await waitResponse(f.client, "settings/get", "sg1");
    expect(errOf(gate).code).toBe("trust_required");
    // 信任后：合并视图 + raw 两级
    f.send({ type: "settings/get", id: "sg2", cwd: "/definitely/path" });
    const merged = await waitResponse(f.client, "settings/get", "sg2");
    expect(merged["data"]).toEqual({ values: {}, sources: {}, raw: { project: {}, user: {} } });
    // set 白名单
    f.send({ type: "settings/set", id: "ss1", key: "bogus.key", value: 1 });
    const unknownKey = await waitResponse(f.client, "settings/set", "ss1");
    expect(errOf(unknownKey)).toEqual({ code: "invalid_input", message: "unknown setting key: bogus.key" });
    f.send({ type: "settings/set", id: "ss2", key: "thinking.default", value: "huge" });
    const badValue = await waitResponse(f.client, "settings/set", "ss2");
    expect(errOf(badValue).code).toBe("invalid_input");
    f.send({ type: "settings/set", id: "ss3", key: "thinking.default", value: "low" });
    await waitResponse(f.client, "settings/set", "ss3");
    f.send({ type: "settings/get", id: "sg3" });
    const values = await waitResponse(f.client, "settings/get", "sg3");
    expect((values["data"] as { values: Record<string, unknown> }).values).toEqual({ "thinking.default": "low" });
    // workspace/trust 相对路径拒 + 坏布尔拒
    f.send({ type: "workspace/trust", id: "wt3", cwd: "rel", trusted: true });
    const rel = await waitResponse(f.client, "workspace/trust", "wt3");
    expect(errOf(rel).code).toBe("invalid_input");
    f.send({ type: "workspace/trust", id: "wt4", cwd: "/tmp", trusted: "yes" });
    const badBool = await waitResponse(f.client, "workspace/trust", "wt4");
    expect(errOf(badBool)).toEqual({ code: "invalid_input", message: "invalid setting value: trusted must be a boolean" });
  });

  test("models/add·remove + set_model_override + auth 面 + providers.json 坏文件降级", async () => {
    const f = await startHost();
    f.send({ type: "models/add", id: "m-bad", provider: "p1", protocol: "bogus", baseUrl: "https://p1" });
    const badProtocol = await waitResponse(f.client, "models/add", "m-bad");
    expect(errOf(badProtocol).code).toBe("invalid_input");
    f.send({ type: "models/add", provider: "p1", protocol: "openai", baseUrl: "https://p1", contextWindow: 128_000 });
    await waitFrame(f.client, (frame) => frame["type"] === "response" && frame["command"] === "models/add" && errOf(frame).message === "invalid model entry: id required");
    // id 兼作模型 id 与响应关联（附录 B——add 的模型 id 字段就是 id）；能力位随回显（单点构造）
    f.send({ type: "models/add", id: "m-1", provider: "p1", protocol: "openai", baseUrl: "https://p1", contextWindow: 128_000, reasoning: false, input: ["text", "image"] });
    const okAdded = await waitResponse(f.client, "models/add", "m-1");
    expect((okAdded["data"] as { model: { id: string; provider: string; reasoning?: boolean; input?: string[] } }).model).toMatchObject({ id: "m-1", provider: "p1", reasoning: false, input: ["text", "image"] });
    // input 词表外成员拒（写门不放拼写错误进盘）
    f.send({ type: "models/add", id: "m-2", provider: "p1", protocol: "openai", baseUrl: "https://p1", input: ["texts"] });
    const badInput = await waitResponse(f.client, "models/add", "m-2");
    expect(errOf(badInput).code).toBe("invalid_input");
    expect(errOf(badInput).message).toContain("input must be an array of text|image");
    // set_model_override 窄合并
    f.send({ type: "set_model_override", id: "ov1", provider: "p1", modelId: "m-1", contextWindow: 64_000 });
    const overridden = await waitResponse(f.client, "set_model_override", "ov1");
    expect((overridden["data"] as { model: { contextWindow?: number } }).model?.contextWindow).toBe(64_000);
    f.send({ type: "set_model_override", id: "ov2", provider: "p1", modelId: "m-1" });
    const nothing = await waitResponse(f.client, "set_model_override", "ov2");
    expect(errOf(nothing).code).toBe("invalid_input");
    expect(errOf(nothing).message).toContain("nothing to set");
    f.send({ type: "set_model_override", id: "ov3", provider: "p1", modelId: "m-1", remove: true, contextWindow: 1 });
    const exclusive = await waitResponse(f.client, "set_model_override", "ov3");
    expect(errOf(exclusive).code).toBe("invalid_input");
    expect(errOf(exclusive).message).toContain("remove is exclusive");
    // remove：预设裸名拒
    f.send({ type: "models/remove", id: "glm-5.3" });
    const preset = await waitResponse(f.client, "models/remove", "glm-5.3");
    expect(errOf(preset).code).toBe("model_unavailable");
    expect(errOf(preset).message).toContain("unknown model preset");
    f.send({ type: "models/remove", id: "m-1" });
    await waitResponse(f.client, "models/remove", "m-1");
    // auth 面：全目录三态 + set/remove
    f.send({ type: "auth/list", id: "al1" });
    const authList = await waitResponse(f.client, "auth/list", "al1");
    const providers = (authList["data"] as { providers: Array<{ provider: string; type: string }> }).providers;
    expect(providers.some((p) => p.provider === "glm" && p.type === "preset-env")).toBe(true);
    f.send({ type: "auth/set_api_key", id: "ak1", provider: "ghost", apiKey: "sk" });
    const domain = await waitResponse(f.client, "auth/set_api_key", "ak1");
    expect(errOf(domain).code).toBe("invalid_input");
    expect(errOf(domain).message).toContain("auth provider not in catalog");
    f.send({ type: "auth/set_api_key", id: "ak2", provider: "glm", apiKey: "" });
    const empty = await waitResponse(f.client, "auth/set_api_key", "ak2");
    expect(errOf(empty)).toEqual({ code: "invalid_input", message: "invalid: apiKey required" });
    f.send({ type: "auth/set_api_key", id: "ak3", provider: "glm", apiKey: "sk-secret" });
    await waitResponse(f.client, "auth/set_api_key", "ak3");
    f.send({ type: "auth/list", id: "al2" });
    const afterSet = await waitResponse(f.client, "auth/list", "al2");
    const glm = ((afterSet["data"] as { providers: Array<{ provider: string; type: string }> }).providers.find((p) => p.provider === "glm"));
    expect(glm?.type).toBe("api-key");
    f.send({ type: "auth/remove_key", id: "rk1", provider: "glm" });
    await waitResponse(f.client, "auth/remove_key", "rk1");
    // 坏 providers.json → hub_error + 预设集仍可列
    await writeFile(join(f.agentDir, "providers.json"), "{oops", "utf8");
    f.send({ type: "get_models", id: "gm1" });
    const models = await waitResponse(f.client, "get_models", "gm1");
    expect((models["data"] as Array<{ source: string }>).every((entry) => entry.source === "preset")).toBe(true);
    // 能力位透传（T39 D10.1）：预设条目带 reasoning/input——目录已知能力直达 wire
    const glmEntry = (models["data"] as Array<{ id: string; reasoning?: boolean; input?: string[] }>).find((entry) => entry.id === "glm-5.3");
    expect(glmEntry?.reasoning).toBe(true);
    expect(glmEntry?.input).toEqual(["text", "image"]);
    const hubErr = await waitFrame(f.client, (frame) => frame["type"] === "hub_error");
    expect(hubErr["message"]).toContain("providers.json unreadable");
  });

  test("agents/create·remove（round-trip）+ agents/list + permission 双域路由矩阵", async () => {
    const f = await startHost();
    f.send({ type: "agents/create", id: "ac1", name: "researcher", description: "", systemPrompt: "you research" });
    const noDesc = await waitResponse(f.client, "agents/create", "ac1");
    expect(errOf(noDesc).code).toBe("invalid_input");
    expect(errOf(noDesc).message).toContain("description required");
    f.send({ type: "agents/create", id: "ac2", name: "researcher", description: "does research", systemPrompt: "you research things", model: "script-1" });
    const created = await waitResponse(f.client, "agents/create", "ac2");
    expect((created["data"] as { path: string }).path).toContain("researcher.md");
    f.send({ type: "agents/list", id: "al1" });
    const listed = await waitResponse(f.client, "agents/list", "al1");
    const agents = (listed["data"] as { agents: Array<{ name: string; source: string; model?: string }> }).agents;
    expect(agents.some((a) => a.name === "researcher" && a.model === "script-1")).toBe(true);
    f.send({ type: "agents/create", id: "ac3", name: "researcher", description: "dup", systemPrompt: "x" });
    const dup = await waitResponse(f.client, "agents/create", "ac3");
    expect(errOf(dup)).toEqual({ code: "name_conflict", message: "agent type already exists: researcher" });
    f.send({ type: "agents/remove", id: "ar1", name: "ghost" });
    const ghost = await waitResponse(f.client, "agents/remove", "ar1");
    expect(errOf(ghost)).toEqual({ code: "state_conflict", message: "unknown agent type: ghost" });
    f.send({ type: "agents/remove", id: "ar2", name: "researcher" });
    await waitResponse(f.client, "agents/remove", "ar2");
    // user 级同名 builtin = 合法遮蔽（create 只扫 user 目录）：遮蔽档可删（T39 集成门
    // 抓出的口径分叉——写侧允许遮蔽则删侧必须放行），裸 builtin 档才拒
    // startHome 注入缝隔离（bun homedir 启动缓存，进程内 HOME 重定向无效）
    f.send({ type: "agents/create", id: "ac4", name: "general-purpose", description: "shadow builtin", systemPrompt: "x" });
    const shadowed = await waitResponse(f.client, "agents/create", "ac4");
    expect(shadowed["success"]).toBe(true);
    f.send({ type: "agents/remove", id: "ar3", name: "general-purpose" });
    const unshadow = await waitResponse(f.client, "agents/remove", "ar3");
    expect(unshadow["success"]).toBe(true);
    f.send({ type: "agents/remove", id: "ar4", name: "code-reviewer" });
    const bareBuiltin = await waitResponse(f.client, "agents/remove", "ar4");
    expect(errOf(bareBuiltin).code).toBe("state_conflict");
    expect(["agent type not user-defined: code-reviewer", "unknown agent type: code-reviewer"]).toContain(errOf(bareBuiltin).message);
    // permission 双域：无 threadId get → 全局默认；set 词表校验
    f.send({ type: "permission/get_mode", id: "pg1" });
    const globalGet = await waitResponse(f.client, "permission/get_mode", "pg1");
    expect(globalGet["data"]).toEqual({ mode: "auto", source: "default" });
    f.send({ type: "permission/set_mode", id: "ps1", mode: "bogus" });
    const badMode = await waitResponse(f.client, "permission/set_mode", "ps1");
    expect(errOf(badMode)).toEqual({ code: "invalid_input", message: "invalid permission mode: bogus" });
    f.send({ type: "permission/set_mode", id: "ps2", mode: "full" });
    await waitResponse(f.client, "permission/set_mode", "ps2");
    f.send({ type: "permission/get_mode", id: "pg2" });
    const afterSet = await waitResponse(f.client, "permission/get_mode", "pg2");
    expect(afterSet["data"]).toEqual({ mode: "full", source: "default" });
    // 未知 threadId → Unknown threadId；parked 表项 set → thread not live
    f.send({ type: "permission/get_mode", id: "pg3", threadId: "ghost" });
    const ghostThread = await waitResponse(f.client, "permission/get_mode", "pg3");
    expect(errOf(ghostThread)).toEqual({ code: "unknown_thread", message: "Unknown threadId" });
  });

  test("thread/list_saved：真实档案折叠（title 派生/updatedAt 序/子代理滤除）", async () => {
    const f = await startHost();
    const mk = async (sid: string, title: string | undefined, agent?: string): Promise<void> => {
      const dir = join(f.sessionsRoot, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd: "/proj", ...(agent !== undefined ? { agentId: agent } : {}) }), "utf8");
      const events = [
        { type: "turn/start", time: 10, data: { turn: 0 } },
        { type: "user/message", time: 11, data: { turn: 0, step: 0, content: [{ type: "text", text: "first user message" }] }, surfaceOp: "append" },
        ...(title !== undefined ? [{ type: "session/meta", time: 12, data: { key: "title", value: title } }] : []),
        { type: "turn/end", time: 13, data: { turn: 0, reason: { kind: "completed" } } },
      ].map((event, index) => ({ ...event, seq: index }));
      await writeFile(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    };
    await mk("saveda", undefined);
    await mk("savedb", "named thread");
    await mk("agentchild", undefined, "agent-12345678");
    f.send({ type: "thread/list_saved", id: "ls1" });
    const listed = await waitResponse(f.client, "thread/list_saved", "ls1");
    const sessions = (listed["data"] as { sessions: Array<{ id: string; title: string; messageCount: number; lastSeq: number; updatedAt: number }> }).sessions;
    expect(sessions.map((s) => s.id).sort()).toEqual(["saveda", "savedb"]); // 子代理滤除
    const a = sessions.find((s) => s.id === "saveda");
    expect(a?.title).toBe("first user message"); // 派生 title
    expect(a?.messageCount).toBe(1);
    expect(a?.lastSeq).toBe(2); // 无 meta——事件 [turn,user,turnend] 共 3 条
  });

  test("skills 面旅程（隔离 HOME）：list 见 user 层 → inspect 三态 → install 落盘 → set_enabled → remove 目录删除", async () => {
    const f = await startHost();
    // agentDir 派生缝：host-hub 运行态 user 根 = <agentDir>/skills（homeDir 注入缝
    // 仅 CLI 直调面生效——此处 runHost 带 agentDir，优先级更高）
    const skillsRoot = join(f.agentDir, "skills");
    // 源技能：一个 ready（声明名 = 目录名）+ 一个 rename（声明名 ≠ 目录名），另加捆绑文件
    const srcRoot = await tempDir("hub-skills-src-");
    const ready = join(srcRoot, "alpha");
    await mkdir(ready, { recursive: true });
    await writeFile(join(ready, "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody", "utf8");
    await writeFile(join(ready, "helper.sh"), "echo hi\n", "utf8");
    const rename = join(srcRoot, "tavily");
    await mkdir(rename, { recursive: true });
    await writeFile(join(rename, "SKILL.md"), "---\nname: tavily-cli\ndescription: CLI\n---\nbody", "utf8");
    const blocked = join(srcRoot, "ghost");
    await mkdir(blocked, { recursive: true });

    f.send({ type: "skills/inspect", id: "si1", sourcePaths: [ready, rename, blocked] });
    const inspected = await waitResponse(f.client, "skills/inspect", "si1");
    expect(inspected["data"]).toEqual({
      results: [
        { sourcePath: ready, state: "ready", name: "alpha", description: "A" },
        { sourcePath: rename, state: "rename", name: "tavily-cli", description: "CLI" },
        { sourcePath: blocked, state: "blocked", problem: "not_found" },
      ],
    });
    // 垃圾入参（相对路径）→ invalid_input
    f.send({ type: "skills/inspect", id: "si2", sourcePaths: ["relative"] });
    expect(errOf(await waitResponse(f.client, "skills/inspect", "si2")).code).toBe("invalid_input");

    f.send({ type: "skills/install", id: "in1", sourcePath: ready });
    const installed = await waitResponse(f.client, "skills/install", "in1");
    expect(installed["data"]).toEqual({ name: "alpha", path: join(skillsRoot, "alpha", "SKILL.md"), skippedEntries: 0 });
    // 落盘事实：捆绑文件同拷、临时树清空
    expect((await stat(join(skillsRoot, "alpha", "helper.sh"))).isFile()).toBe(true);
    expect(await readdir(join(f.agentDir, ".tmp"))).toEqual([]);
    // rename 档：目标目录名 = 声明名
    f.send({ type: "skills/install", id: "in2", sourcePath: rename });
    expect((await waitResponse(f.client, "skills/install", "in2"))["data"]).toEqual({ name: "tavily-cli", path: join(skillsRoot, "tavily-cli", "SKILL.md"), skippedEntries: 0 });

    f.send({ type: "skills/list", id: "sl1" });
    const listed = await waitResponse(f.client, "skills/list", "sl1");
    // 序 = 目录 readdir 序（不排序——按名归一后比对集合）
    const listedSkills = (listed["data"] as { skills: Array<{ name: string; source: string; path: string; disabled: boolean }> }).skills;
    expect([...listedSkills].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "alpha", source: "user", path: join(skillsRoot, "alpha", "SKILL.md"), disabled: false },
      { name: "tavily-cli", source: "user", path: join(skillsRoot, "tavily-cli", "SKILL.md"), disabled: false },
    ]);
    // 同名再装未 overwrite → name_conflict；带 overwrite → 换入
    f.send({ type: "skills/install", id: "in3", sourcePath: ready });
    expect(errOf(await waitResponse(f.client, "skills/install", "in3")).code).toBe("name_conflict");
    f.send({ type: "skills/install", id: "in4", sourcePath: ready, overwrite: true });
    expect((await waitResponse(f.client, "skills/install", "in4"))["success"]).toBe(true);

    // 开关（隔离 HOME 的 user 名单）+ 信任门禁
    f.send({ type: "skills/set_enabled", id: "se1", name: "alpha", enabled: false });
    expect((await waitResponse(f.client, "skills/set_enabled", "se1"))["success"]).toBe(true);
    f.send({ type: "skills/list", id: "sl2" });
    expect(((await waitResponse(f.client, "skills/list", "sl2"))["data"] as { skills: Array<{ name: string; disabled: boolean }> }).skills.find((skill) => skill.name === "alpha")?.disabled).toBe(true);
    f.send({ type: "skills/list", id: "sl3", cwd: "/untrusted" });
    expect(errOf(await waitResponse(f.client, "skills/list", "sl3")).code).toBe("trust_required");
    f.send({ type: "skills/set_enabled", id: "se2", name: "no-such-skill", enabled: false });
    const unknown = await waitResponse(f.client, "skills/set_enabled", "se2");
    expect(errOf(unknown).code).toBe("state_conflict");
    expect(errOf(unknown).message).toContain("unknown skill");

    // 移除 = 删技能目录（回归：残留目录会让每次装载告警）
    f.send({ type: "skills/remove", id: "sr1", name: "alpha" });
    expect((await waitResponse(f.client, "skills/remove", "sr1"))["success"]).toBe(true);
    expect(await stat(join(skillsRoot, "alpha")).catch(() => undefined)).toBeUndefined();
    f.send({ type: "skills/remove", id: "sr2", name: "no-such-skill" });
    const removeUnknown = await waitResponse(f.client, "skills/remove", "sr2");
    expect(errOf(removeUnknown).code).toBe("state_conflict");
    expect(errOf(removeUnknown).message).toContain("unknown skill");
  });

});

describe("thread/delete（BATCH2 §4——host 命令面旅程）", () => {
  test("存档删除成功 + 幂等 + 目录消失；未知路径形状拒", async () => {
    const f = await startHost();
    const sessionsRoot = join(f.agentDir, "sessions");
    const id = "delarc1";
    await mkdir(join(sessionsRoot, id), { recursive: true });
    await writeFile(join(sessionsRoot, id, "header.json"), JSON.stringify({ id, createdAt: 1, cwd: "/w" }), "utf8");
    await writeFile(join(sessionsRoot, id, "events.jsonl"), `${JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } })}\n`, "utf8");
    const sessionPath = join(sessionsRoot, id, "events.jsonl");
    f.input.send({ type: "thread/delete", id: "d1", sessionPath });
    const ok = await waitResponse(f.client, "thread/delete", "d1");
    expect(ok["success"]).toBe(true);
    expect(ok["data"]).toEqual({ removed: ["delarc1"] }); // 级联结果透传（T39 D10.3）
    await expect(stat(join(sessionsRoot, id))).rejects.toMatchObject({ code: "ENOENT" });
    f.input.send({ type: "thread/delete", id: "d2", sessionPath });
    const again = await waitResponse(f.client, "thread/delete", "d2");
    expect(again["success"]).toBe(true); // 幂等
    expect(again["data"]).toEqual({ removed: [] });
    f.input.send({ type: "thread/delete", id: "d3", sessionPath: "relative/path" });
    const bad = await waitResponse(f.client, "thread/delete", "d3");
    expect(bad["success"]).toBe(false);
    expect(errOf(bad).code).toBe("path_forbidden");
    expect(errOf(bad).message).toContain("absolute path required");
  });
});
