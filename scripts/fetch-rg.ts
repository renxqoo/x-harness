// rg 获取脚本（docs/TOOLBOX.md §5 获取形态）：打包期按平台矩阵下载 ripgrep 官方
// release 到 apps/host-hub/dist/bin/（rg 755 + rg.json manifest）。钉死版本与 sha256——
// 制品可控前提下的确定性获取；桌面安装器把 dist/bin/rg 原样放进根配置的 agent 目录
// （如 .pai/agent/bin/——目录不是写死事实，运行时由 X_HARNESS_HOME / HUB_AGENT_DIR
// 根配置链推导）。不进 build 门（build 零网络依赖）；打包序 = fetch:rg && build。
// 并发口径：同目录并发跑不同 target 是打包机误用（矩阵每平台一个产物目录）——最坏
// 序留下 rg/manifest 平台错配，下次 isUpToDate 不匹配自动重取自愈（已知落档）。

import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const RG_VERSION = "15.1.0";

/** 平台矩阵（POSIX 四目标；用户裁决：按平台矩阵打包——什么平台打什么包）。
 *  linux-x64 用 musl 静态资产（15.1.0 无 x86_64-gnu 官方资产；静态二进制 glibc/musl 通吃）。 */
export interface RgTarget {
  readonly triple: string;
  readonly sha256: string;
}

export const RG_TARGETS: Readonly<Record<string, RgTarget>> = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715" },
  "darwin-x64": { triple: "x86_64-apple-darwin", sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e" },
  "linux-x64": { triple: "x86_64-unknown-linux-musl", sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599" },
} as const;

/** 矩阵键取目标（noUncheckedIndexedAccess 口径：缺席 fail-closed throw——键词表封闭） */
export function targetOf(key: string): RgTarget {
  const target = RG_TARGETS[key];
  if (target === undefined) throw new Error(`unknown rg target key: ${key}`);
  return target;
}

/** process.platform/arch → 矩阵键；无映射返回 null（Windows 等非 POSIX 平台——整仓 POSIX-only） */
export function targetKeyOf(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `linux-${arch}`;
  return null;
}

export function downloadUrlOf(target: RgTarget): string {
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${target.triple}.tar.gz`;
}

/** tar.gz 内 rg 成员路径（官方资产固定布局 ripgrep-<ver>-<triple>/rg） */
export function memberPathOf(target: RgTarget): string {
  return `ripgrep-${RG_VERSION}-${target.triple}/rg`;
}

export interface Manifest {
  readonly version: string;
  readonly target: string;
  readonly sha256: string;
}

export function manifestOf(target: RgTarget): Manifest {
  return { version: RG_VERSION, target: target.triple, sha256: target.sha256 };
}

/** 幂等判定：manifest 与盘上 rg 双在场且与期望一致（rg.json 缺席/损坏/不匹配 = 不幂等） */
export function isUpToDate(manifestPath: string, rgPath: string, expected: Manifest): boolean {
  if (!existsSync(manifestPath) || !existsSync(rgPath) || !statSync(rgPath).isFile()) return false;
  let parsed: Manifest;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return false;
  }
  return parsed.version === expected.version && parsed.target === expected.target && parsed.sha256 === expected.sha256;
}

/** 解析 argv 的 --target <matrix-key | triple>；缺省当前平台矩阵键 */
export function resolveRequestedTarget(args: readonly string[], platform: NodeJS.Platform, arch: string): { readonly key: string; readonly target: RgTarget } | { readonly error: string } {
  const idx = args.indexOf("--target");
  const raw = idx >= 0 ? args[idx + 1] : undefined;
  if (idx >= 0 && raw === undefined) return { error: "--target requires a value (e.g. --target x86_64-unknown-linux-musl)" };
  if (raw === undefined) {
    const key = targetKeyOf(platform, arch);
    if (key === null) return { error: `unsupported platform ${String(platform)}/${arch} (POSIX targets only; pass --target)` };
    return { key, target: targetOf(key) };
  }
  const byKey = RG_TARGETS[raw];
  if (byKey !== undefined) return { key: raw, target: byKey };
  const hit = Object.entries(RG_TARGETS).find(([, t]) => t.triple === raw);
  if (hit !== undefined) return { key: hit[0], target: hit[1] };
  return { error: `unknown target ${raw}; known: ${Object.values(RG_TARGETS).map((t) => t.triple).join(", ")}` };
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function distBinDir(root: string = repoRoot()): string {
  return join(root, "apps/host-hub/dist/bin");
}

async function fetchTo(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`download failed: ${String(response.status)} ${url}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
}

/** 系统 tar 抽取单成员到 dest（POSIX-only 前提——整仓同口径；-O 流式 stdout 免临时展开树）。
 *  抽取注入兼容性装置：fetchRg 测试以此替换网络下载面，真链路由打包机实跑背书。 */
export async function extractWithTar(archive: string, member: string, dest: string): Promise<void> {
  const proc = Bun.spawn(["tar", "-xzf", archive, "-O", member], { stdout: "pipe", stderr: "pipe" });
  const out = createWriteStream(dest);
  await pipeline(proc.stdout as unknown as ReadableStream<Uint8Array>, out);
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (${String(code)}): ${err.trim()}`);
  }
}

export async function fetchRg(input: {
  readonly key: string;
  readonly target: RgTarget;
  readonly binDir?: string;
  readonly log?: (message: string) => void;
}): Promise<{ readonly status: "up-to-date" | "fetched"; readonly rgPath: string }> {
  const log = input.log ?? ((m: string) => console.log(m));
  const binDir = input.binDir ?? distBinDir();
  const rgPath = join(binDir, "rg");
  const manifestPath = join(binDir, "rg.json");
  const expected = manifestOf(input.target);
  mkdirSync(binDir, { recursive: true });
  if (isUpToDate(manifestPath, rgPath, expected)) {
    log(`rg ${RG_VERSION} ${input.target.triple}: up-to-date (${rgPath})`);
    return { status: "up-to-date", rgPath };
  }
  const url = downloadUrlOf(input.target);
  const archive = join(binDir, `.rg-${input.key}.tar.gz`);
  const tmp = join(binDir, `.rg-${input.key}.tmp`); // key 后缀：跨目标并发不互踩同用一 .tmp
  log(`downloading ${url}`);
  try {
    await fetchTo(url, archive);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (digest !== input.target.sha256) throw new Error(`sha256 mismatch for ${url}: got ${digest}`);
    await extractWithTar(archive, memberPathOf(input.target), tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, rgPath);
    writeFileSync(manifestPath, `${JSON.stringify(expected, null, 2)}\n`);
  } finally {
    // 失败路径同样清干净：半成品 archive/.tmp 不随发版（安装器按目录拷贝）
    await rm(archive, { force: true });
    await rm(tmp, { force: true });
  }
  log(`rg ${RG_VERSION} ${input.target.triple}: fetched -> ${rgPath}`);
  return { status: "fetched", rgPath };
}

// --- CLI 入口（import 时不执行；import.meta.main 与仓内其余脚本同口径——路径含空格时
// file URL percent-encoding 会让 file:// 拼接比较恒 false，静默空跑） ---
if (import.meta.main) {
  const requested = resolveRequestedTarget(argv.slice(2), process.platform, process.arch);
  if ("error" in requested) {
    console.error(`fetch-rg: ${requested.error}`);
    process.exit(1);
  }
  try {
    await fetchRg({ key: requested.key, target: requested.target });
  } catch (error) {
    console.error(`fetch-rg: ${String(error)}`);
    process.exit(1);
  }
}
