// CLI 入口（docs/CLI.md §2.1/§3）：解析 → 短路命令 → providers.json → 会话计划 →
// 装配 → 模式分派（print / REPL）→ 退出清理 → 退出码。进程绑定经 CliIO 注入（可测）。

import type { AgentHandle } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import { buildWorld } from "./build-world.ts";
import type { World } from "./build-world.ts";
import { buildInitialMessage } from "./build-initial-message.ts";
import { createTerminalBrokerPlugin } from "./broker-terminal.ts";
import type { BrokerIO } from "./broker-terminal.ts";
import { registerCliPromptSections } from "./cli-prompt-sections.ts";
import { defaultSessionRoot, providersPath } from "./harness-home.ts";
import { newSessionId } from "./new-session-id.ts";
import { parseCliArgs, usageText } from "./parse-cli-args.ts";
import type { CliArgs } from "./parse-cli-args.ts";
import { pickIndex, pickSession, formatSessionList } from "./pick-session.ts";
import { processFileArgs } from "./process-file-args.ts";
import { readProvidersConfig } from "./providers-file.ts";
import type { ProvidersConfig } from "./providers-file.ts";
import { readPipedStdin } from "./read-stdin.ts";
import { agentOptionsForCreate, agentOptionsForResume } from "./resolve-agent-options.ts";
import { resolveModel } from "./resolve-model.ts";
import type { ModelResolution } from "./resolve-model.ts";
import { continueCandidate, mainSessions, matchPrefix } from "./resolve-session.ts";
import { runPrintMode } from "./run-print-mode.ts";
import { runRepl } from "./run-repl.ts";
import readline from "node:readline";
import { Writable } from "node:stream";
import pkg from "../package.json";

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly platform: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** stdout/stderr EPIPE（下游关管道）静默停写——print 循环对断管自行降级收尾 */
function guarded(write: (text: string) => void): (text: string) => void {
  return (text) => {
    try {
      write(text);
    } catch (error) {
      if ((error as { code?: string }).code !== "EPIPE") throw error;
    }
  };
}

/** guarded + 断管回调（REPL：EPIPE 触发清理退出而非继续在死管上跑） */
function guardedEpipe(write: (text: string) => void, onBroken: () => void): (text: string) => void {
  let broken = false;
  return (text) => {
    if (broken) return;
    try {
      write(text);
    } catch (error) {
      if ((error as { code?: string }).code !== "EPIPE") throw error;
      broken = true;
      onBroken();
    }
  };
}

/** 一次性 readline 的 echo 出面（EPIPE 吞掉，与 guarded 同口径） */
function epipeSafeWritable(io: CliIO): Writable {
  return new Writable({
    write: (chunk, _encoding, callback) => {
      try {
        io.stdout(chunk.toString("utf8"));
        callback();
      } catch (error) {
        if ((error as { code?: string }).code === "EPIPE") callback();
        else callback(error instanceof Error ? error : undefined);
      }
    },
  });
}

function listModelsLines(config: ProvidersConfig, search: string | undefined): string {
  const lines: string[] = [];
  for (const profile of config.providers) {
    for (const model of profile.models) {
      if (search === undefined || model.includes(search)) lines.push(`${profile.name}  ${model}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** 会话计划：archive 纯读探针（不装世界、不占锁）。pick/ambiguous 形态只在交互下可达
 *  （选择 UI 需要 stdin 所有权）；非交互一律 fail（exit 2） */
type SessionPlanOutcome =
  | { readonly kind: "resume"; readonly id: SessionId }
  | { readonly kind: "new" }
  | { readonly kind: "pick"; readonly headers: readonly import("@x-harness/session").SessionHeader[] }
  | { readonly kind: "ambiguous"; readonly ids: readonly SessionId[] }
  | { readonly kind: "fail"; readonly reason: string };

async function planResumeId(args: CliArgs, io: CliIO, interactive: boolean): Promise<SessionPlanOutcome> {
  const needsArchive = args.session !== undefined || args.continueRecent || args.resume;
  if (!needsArchive) return { kind: "new" };
  const headers = await createArchiveReader(args.sessionDir ?? defaultSessionRoot(io.env)).listHeaders();
  if (args.session !== undefined) {
    const match = matchPrefix(headers, args.session);
    if (match.status === "unique") return { kind: "resume", id: match.id };
    if (match.status === "none") return { kind: "fail", reason: `no session matches prefix "${args.session}"` };
    if (!interactive) return { kind: "fail", reason: `prefix "${args.session}" is ambiguous: ${match.candidates.join(", ")}` };
    return { kind: "ambiguous", ids: match.candidates };
  }
  if (args.continueRecent) {
    const id = continueCandidate(headers, io.cwd);
    return id === undefined ? { kind: "new" } : { kind: "resume", id };
  }
  const list = mainSessions(headers);
  if (list.length === 0) return { kind: "fail", reason: "no saved sessions" };
  if (!interactive) return { kind: "fail", reason: "-r/--resume needs an interactive terminal to pick a session" };
  return { kind: "pick", headers: list };
}

/** 交互选择（一次性 readline，REPL 接管 stdin 之前完成）：取消/垃圾输入 = 新会话 */
async function chooseSessionInteractive(plan: { kind: "pick"; headers: readonly import("@x-harness/session").SessionHeader[] } | { kind: "ambiguous"; ids: readonly SessionId[] }, io: CliIO): Promise<SessionId | undefined> {
  const rl = readline.createInterface({ input: io.stdin, output: epipeSafeWritable(io), terminal: false });
  const question = (prompt: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  try {
    if (plan.kind === "pick") {
      io.stdout(`${formatSessionList(plan.headers).join("\n")}\n`);
      return await pickSession(plan.headers, question);
    }
    io.stdout(`${plan.ids.map((id, index) => `${String(index + 1)}. ${id}`).join("\n")}\n`);
    const index = await pickIndex(plan.ids.length, question);
    return index === undefined ? undefined : plan.ids[index];
  } finally {
    rl.close();
  }
}

/** broker IO：交互形态的提问面由 REPL 终端经 wireAsk 回填（buildWorld 前先占位） */
function brokerIO(io: CliIO, interactive: boolean, ask: (prompt: string) => Promise<string | undefined>): BrokerIO {
  return {
    interactive,
    write: (line) => io.stderr(`${line}\n`),
    question: ask,
  };
}

/** 装配世界 + 建立/恢复初始会话 + flush 屏障（session-locked 快速失败）；失败自清理 */
async function openWorld(input: {
  readonly args: CliArgs;
  readonly config: ProvidersConfig;
  readonly resolution: ModelResolution;
  readonly io: CliIO;
  readonly interactive: boolean;
  readonly resumeId: SessionId | undefined;
  readonly ask: (prompt: string) => Promise<string | undefined>;
}): Promise<{ readonly world: World; readonly handle: AgentHandle } | { readonly failure: string }> {
  const { args, config, resolution, io } = input;
  const built = await buildWorld({
    cwd: io.cwd,
    sessionRoot: args.sessionDir ?? defaultSessionRoot(io.env),
    persist: !args.noSession,
    config,
    resolution,
    broker: createTerminalBrokerPlugin(brokerIO(io, input.interactive, input.ask)),
  });
  if (!built.ok) return { failure: built.reason };
  const world = built.value;
  const registered = world.registry.schemas().map((schema) => schema.name);
  const made = input.resumeId === undefined
    ? await world.loop.create({ session: { id: newSessionId() }, agent: agentOptionsForCreate(args, resolution.defaults, registered) })
    : await world.loop.resume({ id: input.resumeId, agent: agentOptionsForResume(args, resolution.overrides, registered) });
  if (!made.ok) {
    await world.ctx.dispose().catch(() => {});
    return { failure: made.reason };
  }
  if (!args.systemPrompt) {
    world.ctx.effect(registerCliPromptSections(world.prompt, { cwd: io.cwd, platform: io.platform, date: today() }, args.appendSystemPrompts));
  }
  const flushed = await world.store.flush(made.value.agent.session.id);
  if (!flushed.ok) {
    await made.value.dispose().catch(() => {});
    await world.ctx.dispose().catch(() => {});
    return { failure: flushed.reason };
  }
  return { world, handle: made.value };
}

export async function cliMain(argv: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.reason}\ntry --help\n`);
    return 2;
  }
  const args = parsed.value;
  if (args.version) {
    io.stdout(`${pkg.version}\n`);
    return 0;
  }
  if (args.help) {
    io.stdout(usageText("x-harness"));
    return 0;
  }
  const providers = await readProvidersConfig(providersPath(io.env));
  if (!providers.ok) {
    io.stderr(`${providers.reason}\n`);
    return 2;
  }
  if (args.listModels) {
    io.stdout(listModelsLines(providers.value, args.listModelsSearch));
    return 0;
  }
  const resolution = resolveModel(providers.value, { provider: args.provider, model: args.model, thinking: args.thinking, apiKey: args.apiKey });
  if (!resolution.ok) {
    io.stderr(`${resolution.reason}\n`);
    return 2;
  }
  const interactive = !args.print && io.stdinIsTTY;
  const plan = await planResumeId(args, io, interactive);
  if (plan.kind === "fail") {
    io.stderr(`${plan.reason}\n`);
    return 2;
  }
  let resumeId: SessionId | undefined;
  if (plan.kind === "resume") resumeId = plan.id;
  else if (plan.kind === "pick" || plan.kind === "ambiguous") resumeId = await chooseSessionInteractive(plan, io);
  const context: MainContext = { args, config: providers.value, resolution: resolution.value, io, resumeId };
  return interactive ? interactiveMain(context) : printMain(context);
}

/** 主流程共享上下文（参数打包：lint max-params 纪律） */
interface MainContext {
  readonly args: CliArgs;
  readonly config: ProvidersConfig;
  readonly resolution: ModelResolution;
  readonly io: CliIO;
  readonly resumeId: SessionId | undefined;
}

/** print/管道模式：stdin 管道 + @file + 位置参数 → 单次执行退出 */
async function printMain(context: MainContext): Promise<number> {
  const { args, config, resolution, io, resumeId } = context;
  const stdin = await readPipedStdin(io.stdin);
  const files = await processFileArgs(args.fileArgs);
  if (!files.ok) {
    io.stderr(`${files.reason}\n`);
    return 2;
  }
  const initial = buildInitialMessage({ stdin, fileText: files.value.text, firstMessage: args.messages[0] });
  const remaining = args.messages.slice(1);
  if (initial === undefined && remaining.length === 0) {
    io.stderr("no prompt given (pass a message, @file, or pipe stdin)\n");
    return 2;
  }
  const opened = await openWorld({ args, config, resolution, io, interactive: false, resumeId, ask: () => Promise.resolve(undefined) });
  if ("failure" in opened) {
    io.stderr(`startup failed: ${opened.failure}\n`);
    return 1;
  }
  const code = await runPrintMode({
    ctx: opened.world.ctx,
    handle: opened.handle,
    meter: opened.world.meter,
    args,
    initialMessage: initial,
    remainingMessages: remaining,
    streams: { out: guarded(io.stdout), err: guarded(io.stderr) },
    progressTTY: io.stderrIsTTY,
  });
  await opened.handle.dispose().catch(() => {});
  await opened.world.ctx.dispose().catch(() => {});
  return code;
}

/** 交互 REPL：stdin TTY。一次性选择 UI（-r/歧义前缀）先于 REPL 完成；位置参数/@file/
 *  管道 stdin 拼成初始提示依序 kick；stdout EPIPE 经 wireQuit 触发清理退出 */
async function interactiveMain(context: MainContext): Promise<number> {
  const { args, config, resolution, io, resumeId } = context;
  const files = await processFileArgs(args.fileArgs);
  if (!files.ok) {
    io.stderr(`${files.reason}\n`);
    return 2;
  }
  const stdin = await readPipedStdin(io.stdin); // TTY 恒空；防御性保持与 print 同构
  const initial = buildInitialMessage({ stdin, fileText: files.value.text, firstMessage: args.messages[0] });
  const prompts = [...(initial !== undefined ? [initial] : []), ...args.messages.slice(1)];
  let ask: (prompt: string) => Promise<string | undefined> = () => Promise.resolve(undefined);
  let brokenQuit: (code: number) => void = () => {};
  const opened = await openWorld({ args, config, resolution, io, interactive: true, resumeId, ask: (prompt) => ask(prompt) });
  if ("failure" in opened) {
    io.stderr(`startup failed: ${opened.failure}\n`);
    return 1;
  }
  const code = await runRepl({
    world: opened.world,
    handle: opened.handle,
    baseOptions: opened.handle.agent.options,
    args,
    config,
    sessionRoot: args.sessionDir ?? defaultSessionRoot(io.env),
    persist: !args.noSession,
    io: {
      write: guardedEpipe(io.stdout, () => brokenQuit(1)),
      stdin: io.stdin,
      isTTY: io.stdoutIsTTY,
      onSignal: (kind, callback) => {
        process.on(kind, callback);
      },
    },
    initialPrompts: prompts,
    wireAsk: (face) => {
      ask = face;
    },
    wireQuit: (quit) => {
      brokenQuit = quit;
    },
  });
  await opened.world.ctx.dispose().catch(() => {});
  return code;
}

if (import.meta.main) {
  const io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
  };
  process.exit(await cliMain(process.argv.slice(2), io));
}
