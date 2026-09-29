import { takeOverStdout } from "../shared/stdout-guard.ts";
import { createJsonlSplitter } from "../shared/jsonl.ts";
import { CLIENT_LINE_LIMIT, readLimits } from "../shared/limits.ts";
import { buildAssemblySnapshot, ensureAgentDir, readCatalog, resolveDefaultDial } from "../shared/catalog.ts";
import { cleanupBashOutputs } from "../worker/bash-exec.ts";
import { createCredentials } from "./credentials.ts";
import { cleanupTmpResidue } from "./tmp-sweep.ts";
import { migrateLegacySkills } from "./skills-migrate.ts";
import { migrateLegacyAgentTypes } from "./agents-migrate.ts";
import { createThreadTable } from "./thread-table.ts";
import { createWorkerPool } from "./worker-pool.ts";
import { createSweep } from "./thread-retire.ts";
import { createGitWatchService, startGitWatchReconcileLoop } from "./git-watch.ts";
import { eventFrame } from "../protocol/frames.ts";
import { isAbsolute } from "node:path";
import { createDirectRead } from "./read-history.ts";
import { createHostCommands } from "./host-commands.ts";
import { createTelemetryPurge, telemetryDbPathOf } from "./telemetry-purge.ts";
import { heartbeatFrame, hubErrorFrame, responseFrame } from "../protocol/frames.ts";
import { hubError } from "../shared/errors.ts";

const LIVE_WATCH_STATES = new Set(["live", "spawning", "retiring"]);

export interface HostBoot {
  agentDir: string;
  sessionsRoot: string;
  version?: string;
  env?: Record<string, string | undefined>;
  input?: NodeJS.ReadStream;
  exit?: (code: number) => void;
  spawn?: typeof import("./worker-process.ts").spawnWorker;
  emitOverride?: (line: string) => void;
  homeDir?: string;
}

export async function runHost(boot: HostBoot): Promise<void> {
  const env = boot.env ?? process.env;
  const limits = readLimits(env);
  await ensureAgentDir(boot.agentDir);
  await migrateLegacySkills(boot.agentDir, undefined, env);
  await migrateLegacyAgentTypes(boot.agentDir, undefined, env);
  await cleanupBashOutputs(boot.agentDir);
  await cleanupTmpResidue(boot.agentDir);
  let shuttingDown = false;

  const writer =
    boot.emitOverride !== undefined
      ? { write: (line: string) => Promise.resolve(boot.emitOverride?.(line)), idle: () => Promise.resolve(), dropped: () => 0 }
      : takeOverStdout({
          onBroken: () => {
            process.stderr.write("hub: client pipe broken; shutting down\n");
            void shutdown();
          },
        });
  const emitClient = (line: string): void => {
    void writer.write(line);
  };

  process.on("uncaughtException", (error) => {
    emitClient(hubErrorFrame(String(error)));
  });
  process.on("unhandledRejection", (reason) => {
    emitClient(hubErrorFrame(String(reason)));
  });

  let cpuPrev = process.cpuUsage();
  const heartbeat = setInterval(() => {
    const next = process.cpuUsage();
    const delta = (next.user - cpuPrev.user + next.system - cpuPrev.system) / 1_000_000;
    cpuPrev = next;
    emitClient(heartbeatFrame({ rssBytes: process.memoryUsage().rss, cpuPercent: Number(((delta / 1000) * 100).toFixed(1)) }));
  }, 1_000);

  const table = createThreadTable();
  const credentials = createCredentials(boot.agentDir);
  let snapshotCache: Record<string, string> = {};
  const refreshSnapshot = async (): Promise<void> => {
    if (env["HUB_WORKER_PROVIDER"] === "script") {
      snapshotCache = {
        HUB_WORKER_PROVIDER: "script",
        ...(env["HUB_WORKER_SCRIPT"] !== undefined ? { HUB_WORKER_SCRIPT: env["HUB_WORKER_SCRIPT"] } : {}),
      };
      return;
    }
    const catalogNow = await readCatalog(boot.agentDir);
    const creds = await credentials.read();
    const providers = buildAssemblySnapshot(catalogNow, creds.keys, env);
    const modelMeta: Record<string, { reasoning?: boolean; input?: ("text" | "image")[]; contextWindow?: number }> = {};
    for (const entry of catalogNow.entries) {
      modelMeta[entry.model] = {
        reasoning: entry.reasoning,
        ...(entry.input !== undefined ? { input: [...entry.input] } : {}),
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      };
    }
    const defaults = resolveDefaultDial(catalogNow);
    snapshotCache = {
      HUB_WORKER_PROVIDERS: JSON.stringify({
        providers,
        ...(defaults !== undefined ? { default: defaults } : {}),
        modelMeta,
      }),
    };
  };
  await refreshSnapshot();

  const pool = createWorkerPool({
    table,
    emitClient,
    limits: { maxThreads: limits.maxThreads, workerExitTimeoutMs: limits.workerExitTimeoutMs },
    ...(boot.spawn !== undefined ? { spawn: boot.spawn } : {}),
    workerEnv: () => {
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) base[k] = v;
      }
      base["HUB_AGENT_DIR"] = boot.agentDir;
      base["HUB_SESSIONS_ROOT"] = boot.sessionsRoot;
      for (const [k, v] of Object.entries(snapshotCache)) base[k] = v;
      return base;
    },
  });

  const direct = createDirectRead({ sessionsRoot: boot.sessionsRoot });
  const telemetryPurge = createTelemetryPurge({ dbPath: telemetryDbPathOf(boot.agentDir) });
  const commands = createHostCommands(
    {
      table,
      pool,
      direct,
      telemetryPurge,
      agentDir: boot.agentDir,
      sessionsRoot: boot.sessionsRoot,
      limits,
      setLimits: (patch) => Object.assign(limits, patch),
      emitClient,
      startedAt: Date.now(),
      version: boot.version ?? "0.0.1",
      ...(boot.homeDir !== undefined ? { homeDir: boot.homeDir } : {}),
    },
    {
      broadcastToWorkers: (line) => {
        for (const threadId of pool.liveThreadIds()) {
          void pool.deliverRaw(threadId, line);
        }
      },
      refreshSnapshot,
    },
  );

  const sweep = createSweep({ table, pool, limits: { idleRetireMs: limits.idleRetireMs, workerStaleMs: limits.workerStaleMs, rssRetireBytes: limits.rssRetireBytes } });
  sweep.start();

  const gitWatch = createGitWatchService({
    emit: (frame) => emitClient(eventFrame({ threadId: frame.threadId, name: "git/changed", payload: { cwd: frame.cwd, ...(frame.branch !== undefined ? { branch: frame.branch } : {}) } })),
    liveThreads: () => table.list().filter((entry) => LIVE_WATCH_STATES.has(entry.state) && isAbsolute(entry.cwd)).map((entry) => ({ threadId: entry.threadId, cwd: entry.cwd })),
    onError: (message) => process.stderr.write(`hub: ${message}\n`),
  });
  const stopGitReconcile = startGitWatchReconcileLoop(gitWatch);
  gitWatch.reconcile();

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    sweep.stop();
    gitWatch.stop();
    stopGitReconcile();
    clearInterval(heartbeat);
    telemetryPurge.close();
    await pool.shutdownAll();
    await writer.idle();
    (boot.exit ?? ((code: number) => process.exit(code)))(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  const input = boot.input ?? process.stdin;
  const splitter = createJsonlSplitter({ maxLineBytes: CLIENT_LINE_LIMIT });
  return new Promise<void>((resolve) => {
    input.on("data", (chunk: Buffer) => {
      const { lines, oversize } = splitter.feed(chunk);
      if (oversize > 0) {
        process.stderr.write("hub: parse failure: line exceeds limit\n");
        emitClient(responseFrame({ command: "parse", success: false, error: hubError("protocol", "parse failure") }));
      }
      for (const line of lines) {
        let parsed: { type?: unknown; id?: unknown };
        try {
          parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
        } catch (error) {
          process.stderr.write(`hub: parse failure: invalid JSON (${String(error)})\n`);
          emitClient(responseFrame({ command: "parse", success: false, error: hubError("protocol", "parse failure") }));
          continue;
        }
        if (shuttingDown) {
          emitClient(responseFrame({ ...(typeof parsed.id === "string" ? { id: parsed.id } : {}), command: typeof parsed.type === "string" ? parsed.type : "parse", success: false, error: hubError("protocol", "shutting down") }));
          continue;
        }
        void commands
          .handle(parsed as { type?: unknown; id?: unknown; [key: string]: unknown })
          .then((handled) => {
            if (!handled) void pool.routeLine(line);
          })
          .catch((error: unknown) => {
            const failId = typeof parsed.id === "string" ? parsed.id : undefined;
            emitClient(responseFrame({ ...(failId !== undefined ? { id: failId } : {}), command: typeof parsed.type === "string" ? parsed.type : "unknown", success: false, error: hubError("internal", String(error instanceof Error ? error.message : error)) }));
            emitClient(hubErrorFrame(String(error)));
          });
      }
    });
    input.on("end", () => {
      void shutdown().then(() => resolve());
    });
  });
}
