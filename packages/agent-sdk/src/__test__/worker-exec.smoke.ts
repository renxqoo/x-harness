import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnWorker } from "../index.ts";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sdk-smoke-"));
  const lines: string[] = [];
  let closed = false;
  let violation: string | undefined;
  const handle = spawnWorker({
    env: {
      ...process.env,
      HUB_AGENT_DIR: root,
      HUB_SESSIONS_ROOT: join(root, "sessions"),
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "smoke-ok" }]),
    } as unknown as Record<string, string>,
    exec: { command: process.execPath, args: [resolve(import.meta.dirname, "../../../../apps/host-hub/dist/host/cli.js"), "--internal-worker"] },
    onLine: (line) => {
      lines.push(line);
    },
    onViolation: (reason) => {
      violation = reason;
    },
    onClosed: () => {
      closed = true;
    },
    stderrPrefix: "smoke-worker:",
  });
  const waitHello = new Promise<void>((resolve, reject) => {
    const iv = setInterval(() => {
      if (lines.some((line) => line.startsWith('{"type":"hello"'))) {
        clearInterval(iv);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(iv);
      reject(new Error(`hello timeout; violation=${violation ?? "none"}; lines=${lines.length}`));
    }, 15_000).unref?.();
  });
  await waitHello;
  handle.eof();
  await handle.exited;
  if (!closed) throw new Error("worker not closed");
  const hello = lines.find((line) => line.startsWith('{"type":"hello"'));
  if (hello === undefined) throw new Error("hello frame missing");
  if (hello !== '{"type":"hello","protocolVersion":1,"backendId":"x-harness"}') {
    throw new Error(`hello mismatch: ${hello}`);
  }
  process.stdout.write("worker-exec smoke: hello handshake OK via sdk spawnWorker + workerExecPath\n");
  await rm(root, { recursive: true, force: true });
}

await main();
