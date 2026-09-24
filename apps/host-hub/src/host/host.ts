// host 引导（DESIGN §1/§7）：stdout 接管 → 心跳 1Hz（先于一切慢速装配——覆盖启动
// 窗口）→ 命令路由（host 本地 → 池）→ sweep → 优雅停机（一次性跑完；EOF/SIGTERM/
// SIGINT；关闭期在飞不补响应、新命令 failure）。uncaught/rejection 只发 hub_error
// 不退出。cpuPercent = process.cpuUsage 1s 差分单核归一。
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
import { createDirectRead } from "./read-history.ts";
import { createHostCommands } from "./host-commands.ts";
import { heartbeatFrame, hubErrorFrame, responseFrame } from "../protocol/frames.ts";
import { hubError } from "../shared/errors.ts";

export interface HostBoot {
  agentDir: string;
  sessionsRoot: string;
  version?: string;
  env?: Record<string, string | undefined>;
  /** 测试注入 */
  input?: NodeJS.ReadStream;
  exit?: (code: number) => void;
  /** spawn 注入缝（单测假 worker；缺省真进程） */
  spawn?: typeof import("./worker-process.ts").spawnWorker;
  /** 帧出口注入缝（单测收帧断言；缺省接管 stdout） */
  emitOverride?: (line: string) => void;
  /** user 级 agents 目录的 HOME 注入缝（缺省真实 HOME；单测隔离——bun homedir 启动缓存） */
  homeDir?: string;
}

export async function runHost(boot: HostBoot): Promise<void> {
  const env = boot.env ?? process.env;
  const limits = readLimits(env);
  await ensureAgentDir(boot.agentDir);
  await migrateLegacySkills(boot.agentDir, undefined, env); // 一次性搬运旧共享根技能（幂等哨兵；env 关闭缝；先于清扫/装配）
  await migrateLegacyAgentTypes(boot.agentDir, undefined, env); // 同法：agents 类型根（agentDir 派生缝存量腿）
  await cleanupBashOutputs(boot.agentDir); // 启动清扫超 7 天溢写文件
  await cleanupTmpResidue(boot.agentDir); // 启动清扫原子写残留
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

  // uncaught/rejection 注册先于一切慢速装配（覆盖 catalog/凭据读取窗口——窗口内
  // 未捕获异常只发 hub_error 不崩进程）
  process.on("uncaughtException", (error) => {
    emitClient(hubErrorFrame(String(error)));
  });
  process.on("unhandledRejection", (reason) => {
    emitClient(hubErrorFrame(String(reason)));
  });

  // 心跳先于慢速装配（覆盖 catalog 读取窗口）
  let cpuPrev = process.cpuUsage();
  const heartbeat = setInterval(() => {
    const next = process.cpuUsage();
    const delta = (next.user - cpuPrev.user + next.system - cpuPrev.system) / 1_000_000; // ms
    cpuPrev = next;
    emitClient(heartbeatFrame({ rssBytes: process.memoryUsage().rss, cpuPercent: Number(((delta / 1000) * 100).toFixed(1)) }));
  }, 1_000);

  const table = createThreadTable();
  const credentials = createCredentials(boot.agentDir);
  // 装配快照缓存：引导期算一次 + 每次 auth/models 命令后刷新（workerEnv 同步合并
  // ——spawn 期不再有异步读凭据的竞窗；目录条目现算以覆盖 providers.json 热刷新）
  let snapshotCache: Record<string, string> = {};
  const refreshSnapshot = async (): Promise<void> => {
    if (env["HUB_WORKER_PROVIDER"] === "script") {
      // 测试缝直通（HUB_WORKER_SCRIPT 内联剧本——host 不掺真凭据）
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
      // contextWindow 为目录已解析值（模型级 > 档案级——entryOf 单点）：模型窗口解析与
      // compaction/analytics 面共源
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
  const commands = createHostCommands(
    {
      table,
      pool,
      direct,
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

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    sweep.stop();
    clearInterval(heartbeat);
    await pool.shutdownAll();
    await writer.idle(); // 末帧冲刷完成再退出（防截断）
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
            // 异常兜底：带 id 合成恰一 failure（hub_error 无 id 不可对账——不单独承担）
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
