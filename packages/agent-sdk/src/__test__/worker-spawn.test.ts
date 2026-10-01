import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorker, workerExecPath } from "../executor-worker/spawn.ts";
import { helloFrame } from "../frames.ts";

function echoWorkerScript(): string {
  return [
    'const lines: string[] = [];',
    'let pending = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk: string) => {',
    '  pending += chunk;',
    '  for (;;) {',
    '    const nl = pending.indexOf("\\n");',
    '    if (nl < 0) break;',
    '    const line = pending.slice(0, nl);',
    '    pending = pending.slice(nl + 1);',
    '    if (line === "") continue;',
    '    process.stdout.write(JSON.stringify({ echo: line }) + String.fromCharCode(10));',
    '  }',
    '});',
  ].join("\n");
}

describe("executor-worker spawn", () => {
  it("spawnWorker 通过注入 exec 起 echo worker，行协议往返", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-wspawn-"));
    try {
      const script = join(root, "echo.ts");
      await writeFile(script, echoWorkerScript(), "utf8");
      const lines: string[] = [];
      let closed = false;
      const handle = spawnWorker({
        env: { ...process.env } as Record<string, string>,
        exec: { command: process.execPath, args: [script] },
        onLine: (line) => {
          lines.push(line);
        },
        onViolation: () => {},
        onClosed: () => {
          closed = true;
        },
        stderrPrefix: "test-worker:",
      });
      await handle.write(helloFrame());
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (lines.length >= 1) {
            clearInterval(iv);
            resolve();
          }
        }, 20);
        setTimeout(() => {
          clearInterval(iv);
          resolve();
        }, 10_000).unref?.();
      });
      handle.eof();
      await handle.exited;
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const echoed = JSON.parse(lines[0] ?? "{}") as { echo?: string };
      expect(echoed.echo).toBe(helloFrame());
      expect(closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("workerExecPath 在非 bunfs 环境指向自进程 --internal-worker", () => {
    const resolved = workerExecPath();
    if (process.argv[1] !== undefined && !process.argv[1].startsWith("/$bunfs/")) {
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.args).toEqual([process.argv[1], "--internal-worker"]);
    } else {
      expect(resolved.args).toEqual(["--internal-worker"]);
    }
  });

  it("kill 在宽限期内终止子进程", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-wkill-"));
    try {
      const script = join(root, "hang.ts");
      await writeFile(script, "setInterval(() => {}, 1000);", "utf8");
      let closed = false;
      const handle = spawnWorker({
        env: { ...process.env } as Record<string, string>,
        exec: { command: process.execPath, args: [script] },
        onLine: () => {},
        onViolation: () => {},
        onClosed: () => {
          closed = true;
        },
        stderrPrefix: "test-worker:",
      });
      handle.kill(500);
      await handle.exited;
      expect(closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
