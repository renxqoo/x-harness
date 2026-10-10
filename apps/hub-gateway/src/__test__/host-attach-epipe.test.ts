import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRealNodeBin } from "./kit/node-runtime.ts";

const HOST_ATTACH = new URL("../host-attach.ts", import.meta.url).pathname;

const STDIN_ERROR_LISTENER = /child\.stdin\?\.on\("error",[\s\S]*?\}\);\n/;

interface HarnessOutcome {
  code: number | null;
  stderr: string;
}

async function buildHarness(source: string, name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `ha-epipe-${name}-`));
  const entry = join(dir, "host-attach.ts");
  writeFileSync(entry, source, "utf8");
  await Bun.build({ entrypoints: [entry], target: "node", outdir: dir, format: "esm" });
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    `
import { HostAttach } from "./host-attach.js";
const attach = new HostAttach({
  exec: { command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(()=>{},60000);"] },
  env: process.env,
  heartbeatDeadlineMs: 600000,
  onLine: () => {},
  onRestart: () => {},
  log: () => {},
});
attach.start();
await new Promise((r) => { setTimeout(r, 400); });
for (let i = 0; i < 200; i += 1) attach.deliver("A".repeat(64 * 1024));
attach.killChildForTest();
await new Promise((r) => { setTimeout(r, 200); });
for (let i = 0; i < 200; i += 1) attach.deliver("B".repeat(64 * 1024));
await new Promise((r) => { setTimeout(r, 1500); });
process.stdout.write("HARNESS_SURVIVED\\n");
process.exit(0);
`,
    "utf8",
  );
  return runner;
}

function runOnRealNode(bin: string, runner: string): Promise<HarnessOutcome> {
  const cwd = runner.replace(/\/runner\.mjs$/, "");
  return new Promise((resolve) => {
    const child = spawn(bin, [runner], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      resolve({ code, stderr });
    });
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr });
    }, 20_000);
  });
}

const realNode = await findRealNodeBin();

describe.skipIf(realNode === null)("症状「网关进程被 EPIPE 打死，设备全部掉线」", () => {
  it("真 node 下死管道 hammer 写：挂着 stdin error 监听则宿主存活", { timeout: 90_000 }, async () => {
    const runner = await buildHarness(await Bun.file(HOST_ATTACH).text(), "with");
    const result = await runOnRealNode(realNode as string, runner);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("HARNESS_SURVIVED");
  });

  it("抽掉 stdin error 监听即被打死 —— 这三行是承重墙，删掉必须变红", { timeout: 90_000 }, async () => {
    const source = await Bun.file(HOST_ATTACH).text();
    expect(STDIN_ERROR_LISTENER.test(source)).toBe(true);
    const stripped = source.replace(STDIN_ERROR_LISTENER, "");
    expect(stripped).not.toBe(source);
    const runner = await buildHarness(stripped, "without");
    const result = await runOnRealNode(realNode as string, runner);
    expect(result.code).not.toBe(0);
  });
});