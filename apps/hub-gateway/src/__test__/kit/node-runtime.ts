import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const CANDIDATE_BINS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
const ECHO_HOST = new URL("./echo-host.ts", import.meta.url).pathname;

function nodeVersionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const probe = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      probe.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      probe.once("error", () => {
        resolve(null);
      });
      probe.once("exit", () => {
        resolve(out.trim());
      });
    } catch {
      resolve(null);
    }
  });
}

function pathDirs(): string[] {
  return (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir.length > 0);
}

/** 当前进程在 Bun 下跑（`node` 是 bun 的软链），EPIPE 路径测不出来，必须换真 node。 */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

/** 找真 node（非 bun 伪装）；找不到返回 null —— 用例据此跳过并说明原因。 */
export async function findRealNodeBin(): Promise<string | null> {
  const seen = new Set<string>();
  const candidates = [...CANDIDATE_BINS, ...pathDirs().map((dir) => join(dir, "node"))];
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (!existsSync(bin)) continue;
    const version = await nodeVersionOf(bin);
    if (version === null || !version.startsWith("v")) continue;
    const shim = await isBunShim(bin);
    if (shim) continue;
    return bin;
  }
  return null;
}

function isBunShim(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const probe = spawn(bin, ["-p", "String(process.versions.bun)"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      probe.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      probe.once("error", () => {
        resolve(false);
      });
      probe.once("exit", () => {
        resolve(out.trim() !== "undefined");
      });
    } catch {
      resolve(false);
    }
  });
}
