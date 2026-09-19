// CLI 宿主子进程旅程（docs/CLI.md §4/§5 批E）：真进程装配全量世界 × 本地假 anthropic SSE 服务器。
// 覆盖：短路命令退出码 / print 文本与 @file / JSONL 事件流形态 / --session resume 上下文延续 /
// 会话锁双开拒绝 / REPL pty 驱动（darwin：script 伪终端；他平台该腿跳过并注明）。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "./check.ts";

const CLI_MAIN = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "main.ts");
const TIMEOUT_MS = 30_000;

interface CapturedRequest {
  readonly body: unknown;
}

interface FakeServer {
  readonly port: number;
  readonly requests: CapturedRequest[];
  readonly respond: (text: string) => void;
  readonly stop: () => Promise<void>;
}

/** anthropic wire 假服务器：记录请求体，按队列回剧本文本（docs/LLM-PI.md wire 形态） */
function startFakeAnthropic(): FakeServer {
  const requests: CapturedRequest[] = [];
  const scripted: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.json().catch(() => ({}));
      requests.push({ body });
      const text = scripted.shift() ?? "E2E-FINAL-TEXT";
      const sse = (type: string, fields: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          const push = (line: string): void => controller.enqueue(new TextEncoder().encode(line));
          push(sse("message_start", { message: { usage: { input_tokens: 10 } } }));
          push(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
          push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
          push(sse("content_block_stop", { index: 0 }));
          push(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 8 } }));
          push(sse("message_stop", {}));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("cli-journey: fake server port unavailable");
  return {
    port,
    requests,
    respond: (text) => {
      scripted.push(text);
    },
    stop: () => server.stop(true),
  };
}

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cli-journey: subprocess timeout")), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface CliRequest {
  readonly argv: readonly string[];
  readonly home: string;
  readonly cwd: string;
  /** 管道 stdin 内容（缺省 = ignore） */
  readonly stdin?: string;
}

async function runCli(request: CliRequest): Promise<CliRun> {
  const proc = Bun.spawn([process.execPath, CLI_MAIN, ...request.argv], {
    cwd: request.cwd,
    stdin: request.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, X_HARNESS_HOME: request.home },
  });
  if (request.stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(request.stdin);
    await proc.stdin.flush();
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await withTimeout(Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]));
  return { stdout, stderr, exitCode };
}

/** pty 转发驱动（python3 标准库；BSD script 要求自身 stdin 是 TTY，管道下不可用） */
const PTY_DRIVER = `import os, pty, sys, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
stdin_open = True
while True:
    watchers = [fd] + ([sys.stdin] if stdin_open else [])
    r, _, _ = select.select(watchers, [], [], 0.2)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    if stdin_open and sys.stdin in r:
        data = sys.stdin.buffer.read1(65536)
        if not data:
            stdin_open = False
        else:
            os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))`;

interface PtyRequest {
  readonly home: string;
  readonly cwd: string;
  readonly lines: readonly string[];
  readonly marker: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** REPL pty 驱动（需要 python3；缺席平台该腿跳过并注明——REPL 行为另有进程内管道全链测试） */
async function runReplPty(request: PtyRequest): Promise<CliRun> {
  const { home, cwd, lines, marker } = request;
  if (process.platform !== "darwin") {
    return { stdout: `(skipped: pty leg targets darwin) ${marker}`, stderr: "", exitCode: 0 };
  }
  const proc = Bun.spawn(["python3", "-c", PTY_DRIVER, process.execPath, CLI_MAIN], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, X_HARNESS_HOME: home },
  });
  const collected: string[] = [];
  const pump = (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      collected.push(new TextDecoder().decode(chunk));
    }
  })();
  const deadline = Date.now() + TIMEOUT_MS;
  const [first, ...rest] = lines;
  if (first === undefined) throw new Error("pty journey needs at least one line");
  const bootDeadline = Date.now() + TIMEOUT_MS;
  while (!collected.join("").includes("x-harness v") && Date.now() < bootDeadline) {
    await delay(20);
  }
  // 首行必须在 CLI 就绪（信号处理器已注册）后写入；^C 早到会走进程默认终止
  proc.stdin.write(`${first}\n`);
  await proc.stdin.flush();
  while (!collected.join("").includes(marker) && Date.now() < deadline) {
    await delay(20);
  }
  // 后续行间隔写入：^C 连发会被合并/丢失（内核信号聚合），分开才走双击窗口
  for (const line of rest) {
    await delay(150);
    proc.stdin.write(`${line}\n`);
    await proc.stdin.flush();
  }
  const exitCode = await withTimeout(proc.exited);
  await pump;
  return { stdout: collected.join(""), stderr: "", exitCode };
}

async function makeHome(port: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "xh-cli-home-"));
  await writeFile(join(home, "providers.json"), `${JSON.stringify({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "e2e-key", models: ["m1"] }],
  })}\n`, "utf8");
  return home;
}

function sessionIdOf(stdout: string): string {
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as { type?: string; id?: string };
    if (parsed.type === "session" && typeof parsed.id === "string") return parsed.id;
  }
  throw new Error(`cli-journey: no session line in stdout: ${stdout.slice(0, 200)}`);
}

async function journeyShortCircuits(home: string, cwd: string): Promise<void> {
  const version = await runCli({ argv: ["--version"], home, cwd });
  must(version.exitCode === 0 && version.stdout.trim().length > 0, `--version 应 0 退出并出版本（got ${String(version.exitCode)}: ${version.stdout.slice(0, 50)}）`);
  const help = await runCli({ argv: ["--help"], home, cwd });
  must(help.exitCode === 0 && help.stdout.includes("usage:"), "--help 应输出用法");
  const badFlag = await runCli({ argv: ["--nope"], home, cwd });
  must(badFlag.exitCode === 2 && badFlag.stderr.includes("unknown option"), `未知 flag 应 exit 2（got ${String(badFlag.exitCode)}）`);
  const noPrompt = await runCli({ argv: ["-p"], home, cwd });
  must(noPrompt.exitCode === 2 && noPrompt.stderr.includes("no prompt"), `-p 无提示应 exit 2（got ${String(noPrompt.exitCode)}）`);
}

async function journeyPrintText(server: FakeServer, home: string, cwd: string): Promise<void> {
  server.respond("CLI-E2E-ANSWER");
  const notePath = join(cwd, "note.txt");
  await writeFile(notePath, "FILE-CONTENT-XYZ", "utf8");
  // 管道 stdin 拼在初始消息最前 + @file 附加 + 位置参数为空：stdin+@file 组合形态
  const run = await runCli({ argv: ["-p", `@${notePath}`], home, cwd, stdin: "PIPED-STDIN-PROMPT\n" });
  must(run.exitCode === 0, `print text 应 exit 0（stderr: ${run.stderr.slice(0, 200)}）`);
  must(run.stdout.trim() === "CLI-E2E-ANSWER", `stdout 应纯最终文本（got: ${JSON.stringify(run.stdout.slice(0, 100))}）`);
  const body = JSON.stringify(server.requests[server.requests.length - 1]?.body ?? {});
  must(body.includes("FILE-CONTENT-XYZ"), "@file 内容应进请求上下文");
  must(body.includes("PIPED-STDIN-PROMPT"), "管道 stdin 应拼进初始消息");
}

async function journeyPrintJson(server: FakeServer, home: string, cwd: string): Promise<void> {
  server.respond("JSON-MODE-TEXT");
  const run = await runCli({ argv: ["-p", "--mode", "json", "json please"], home, cwd });
  must(run.exitCode === 0, `json 模式应 exit 0（stderr: ${run.stderr.slice(0, 200)}）`);
  const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; exit?: number; kind?: string });
  must(lines[0]?.type === "session", "JSONL 首行应为 session 头");
  must(lines.some((line) => line.type === "stream" && line.kind === "text"), "JSONL 应含 text 流帧");
  must(lines[lines.length - 1]?.type === "done" && lines[lines.length - 1]?.exit === 0, "JSONL 末行应为 done exit 0");
}

async function journeyResume(server: FakeServer, home: string, cwd: string): Promise<void> {
  server.respond("FIRST-OK");
  const first = await runCli({ argv: ["-p", "--mode", "json", "REMEMBER-TOKEN-42"], home, cwd });
  must(first.exitCode === 0, "resume 首轮应 exit 0");
  const id = sessionIdOf(first.stdout);
  server.respond("SECOND-OK");
  const second = await runCli({ argv: ["--session", id, "-p", "what did I say"], home, cwd });
  must(second.exitCode === 0 && second.stdout.trim() === "SECOND-OK", `resume 二轮应成功（stderr: ${second.stderr.slice(0, 200)}）`);
  const lastBody = JSON.stringify(server.requests[server.requests.length - 1]?.body ?? {});
  must(lastBody.includes("REMEMBER-TOKEN-42"), "resume 后请求应携带首轮上下文（id 前缀恢复 + 日志续读）");

  // --continue：取当前 cwd 最新主会话续聊（上下文延续）
  server.respond("THIRD-OK");
  const third = await runCli({ argv: ["--continue", "-p", "and now?"], home, cwd });
  must(third.exitCode === 0 && third.stdout.trim() === "THIRD-OK", `--continue 应成功（stderr: ${third.stderr.slice(0, 200)}）`);
  must(JSON.stringify(server.requests[server.requests.length - 1]?.body ?? {}).includes("REMEMBER-TOKEN-42"), "--continue 应取最新会话延续上下文");
}

async function journeySessionLock(home: string, cwd: string): Promise<void> {
  const sessionsRoot = join(home, "sessions");
  const id = `locke2e-${String(Date.now())}`;
  const dir = join(sessionsRoot, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "header.json"), `${JSON.stringify({ id, createdAt: Date.now(), cwd })}\n`, "utf8");
  await writeFile(join(dir, "events.jsonl"), "", "utf8");
  await writeFile(join(dir, "lock"), `${process.pid}\n`, "utf8"); // 本测试进程持有活锁
  const run = await runCli({ argv: ["--session", id, "-p", "hi"], home, cwd });
  must(run.exitCode === 1, `活锁双开应 exit 1（got ${String(run.exitCode)}）`);
  must(run.stderr.includes("session-locked"), `stderr 应含 session-locked（got: ${run.stderr.slice(0, 200)}）`);
}

async function journeyRepl(server: FakeServer, home: string, cwd: string): Promise<void> {
  server.respond("REPL-E2E-ANSWER");
  const run = await runReplPty({ home, cwd, lines: ["hello", "/quit"], marker: "REPL-E2E-ANSWER" });
  if (run.stdout.startsWith("(skipped")) return;
  must(run.exitCode === 0, `REPL /quit 应 exit 0（got ${String(run.exitCode)}）`);
  must(run.stdout.includes("REPL-E2E-ANSWER"), "REPL 应流式输出回答");
  must(run.stdout.includes("type /help"), "REPL 应显示启动横幅");

  // Ctrl+C 状态机：idle 双击（500ms 内两次 ^C）退出——首击提示、次击退出
  server.respond("INTERRUPT-ANSWER");
  const interrupted = await runReplPty({ home, cwd, lines: ["\u0003", "\u0003"], marker: "press Ctrl+C again" });
  if (interrupted.stdout.startsWith("(skipped")) return;
  must(interrupted.exitCode === 0, `REPL Ctrl+C 双击应 exit 0（got ${String(interrupted.exitCode)}）`);
  must(interrupted.stdout.includes("press Ctrl+C again"), "首个 ^C 应提示双击退出");
}

export async function runCliJourney(): Promise<void> {
  const server = startFakeAnthropic();
  const home = await makeHome(server.port);
  const cwd = await mkdtemp(join(tmpdir(), "xh-cli-cwd-"));
  try {
    await journeyShortCircuits(home, cwd);
    await journeyPrintText(server, home, cwd);
    await journeyPrintJson(server, home, cwd);
    await journeyResume(server, home, cwd);
    await journeySessionLock(home, cwd);
    await journeyRepl(server, home, cwd);
  } finally {
    await server.stop();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
