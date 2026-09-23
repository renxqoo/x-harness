// 第三方插件安装面（plugin-runtime §2）：源路径只是拷贝源——inspect 形态检查
//（manifest + 全源文件零 @x-harness/* import）→ install 全树拷入 vendor 根（.tmp
// 暂存对装载器永不可见 → 同卷原子 rename 就位 → registry 落账）。哈希 = 就位树
// 的内容指纹（装载期 pin 比对用）。与 skills-install 完全同构的围栏：绝对路径 +
// 无控制字符 + symlink 不复制不跟随 + 拷贝限额。
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { inspectThirdParty } from "@x-harness/plugin-manager";
import type { ThirdPartyManifest } from "@x-harness/plugin-manager";
import { errorOfCause, hubError, type HubErrorShape } from "../shared/errors.ts";
import { updateVendorRegistry, vendorNameBlocked, vendorRootOf } from "../shared/plugins-registry.ts";
import type { VendorPluginEntry } from "../shared/plugins-registry.ts";
import { PLUGIN_IMPORT_MAX_BYTES, PLUGIN_IMPORT_MAX_ENTRIES, PLUGIN_INSPECT_MAX_PATHS } from "../shared/limits.ts";

/** 候选三态（wire 形态对齐 skill）：ready = 可装；rename = manifest 名 ≠ 目录名；
 *  blocked = 问题串（宿主本地化） */
export type PluginCandidate =
  | { readonly sourcePath: string; readonly state: "ready"; readonly manifest: ThirdPartyManifest }
  | { readonly sourcePath: string; readonly state: "rename"; readonly manifest: ThirdPartyManifest }
  | { readonly sourcePath: string; readonly state: "blocked"; readonly problem: string };

/** 绝对路径 + 无控制字符（与 skills-install 同围栏） */
function absolutePathOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return undefined;
  return value;
}

/** 插件名围栏（vendor 根一级目录名——同 skill 名规则） */
export function isPluginName(value: string): boolean {
  if (value === "" || value === "." || value === ".." || value.length > 128) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (char === "/" || char === "\\") return false;
  }
  return true;
}

/** 收集目录内全部源文件（symlink/奇异条目跳过——不复制不跟随；与拷贝阶段同口径） */
async function collectSources(root: string, budget: { entries: number }): Promise<{ ok: true; files: string[] } | { ok: false; error: HubErrorShape }> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      budget.entries += 1;
      if (budget.entries > PLUGIN_IMPORT_MAX_ENTRIES) {
        throw new Error(`plugin source too large: more than ${PLUGIN_IMPORT_MAX_ENTRIES} entries`);
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  try {
    await walk(root);
  } catch (error) {
    return { ok: false, error: hubError("invalid_input", String(error instanceof Error ? error.message : String(error))) };
  }
  return { ok: true, files };
}

/** 读 manifest（plugin.json；缺席/坏 JSON = blocked） */
async function readManifest(root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export async function inspectPluginSource(sourcePath: string): Promise<PluginCandidate> {
  const dirInfo = await lstat(sourcePath).catch(() => undefined);
  if (dirInfo === undefined || !dirInfo.isDirectory()) {
    return { sourcePath, state: "blocked", problem: `not a directory: ${sourcePath}` };
  }
  const manifest = await readManifest(sourcePath);
  const collected = await collectSources(sourcePath, { entries: 0 });
  if (!collected.ok) return { sourcePath, state: "blocked", problem: collected.error.message };
  const sources: { path: string; source: string }[] = [];
  let bytes = 0;
  for (const file of collected.files) {
    const text = await readFile(file, "utf8").catch(() => "");
    bytes += text.length;
    if (bytes > PLUGIN_IMPORT_MAX_BYTES) {
      return { sourcePath, state: "blocked", problem: `plugin source too large: more than ${PLUGIN_IMPORT_MAX_BYTES} bytes` };
    }
    sources.push({ path: file.slice(sourcePath.length + 1), source: text });
  }
  const inspected = inspectThirdParty({ manifest, sources });
  if (!inspected.ok || inspected.manifest === undefined) {
    return { sourcePath, state: "blocked", problem: inspected.reason ?? "unknown" };
  }
  const found = inspected.manifest;
  if (!isPluginName(found.name)) {
    return { sourcePath, state: "blocked", problem: `invalid plugin name: ${found.name}` };
  }
  if (vendorNameBlocked(found.name)) {
    return { sourcePath, state: "blocked", problem: `name conflicts with builtin plugin: ${found.name}` };
  }
  const state = basename(sourcePath) === found.name ? "ready" : "rename";
  return { sourcePath, state, manifest: found };
}

export async function inspectPluginSources(input: { sourcePaths?: unknown }): Promise<{ ok: true; results: PluginCandidate[] } | { ok: false; error: HubErrorShape }> {
  const raw = input.sourcePaths;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLUGIN_INSPECT_MAX_PATHS) {
    return { ok: false, error: hubError("invalid_input", `invalid sourcePaths: 1..${PLUGIN_INSPECT_MAX_PATHS} absolute paths required`) };
  }
  const results: PluginCandidate[] = [];
  for (const value of raw) {
    const path = absolutePathOf(value);
    if (path === undefined) {
      return { ok: false, error: hubError("invalid_input", `invalid sourcePaths: absolute paths required (got ${String(value)})`) };
    }
    results.push(await inspectPluginSource(path));
  }
  return { ok: true, results };
}

interface CopyState {
  bytes: number;
  entries: number;
  skipped: number;
}

/** 递归拷贝（symlink/奇异条目跳过并计数；限额内） */
async function copyTree(src: string, dest: string, state: CopyState): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      state.skipped += 1;
      continue;
    }
    state.entries += 1;
    if (state.entries > PLUGIN_IMPORT_MAX_ENTRIES) {
      throw new Error(`plugin source too large: more than ${PLUGIN_IMPORT_MAX_ENTRIES} entries`);
    }
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, state);
      continue;
    }
    state.bytes += (await stat(from)).size;
    if (state.bytes > PLUGIN_IMPORT_MAX_BYTES) {
      throw new Error(`plugin source too large: more than ${PLUGIN_IMPORT_MAX_BYTES} bytes`);
    }
    await copyFile(from, to);
  }
}

/** 目录内容指纹（文件路径 + 字节，规范化序——装载期 pin 比对） */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) files.push(join(dir.slice(root.length + 1), entry.name));
      else if (entry.isDirectory()) await walk(join(dir, entry.name));
    }
  };
  await walk(root);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface InstallPluginSpec {
  readonly sourcePath?: unknown;
  readonly origin?: "manual" | "agent";
  readonly overwrite?: unknown;
  readonly agentDir: string;
}

export interface InstalledPlugin {
  readonly name: string;
  /** vendor 根内目标目录（装载入口） */
  readonly path: string;
  readonly sha256: string;
  readonly skippedEntries: number;
}

/** vendor 目录就位（备份换入 + 回滚——同 skill placeStaged 律） */
async function placeStaged(staging: string, targetDir: string, tmpBase: string): Promise<void> {
  const backup = join(tmpBase, `plugin-import-old-${randomUUID()}`);
  const existed = await lstat(targetDir).catch(() => undefined);
  try {
    if (existed !== undefined) await rename(targetDir, backup);
    await rename(staging, targetDir);
  } catch (error) {
    if (existed !== undefined) await rename(backup, targetDir).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (existed !== undefined) await rm(backup, { recursive: true, force: true });
}

export async function installPlugin(input: InstallPluginSpec): Promise<{ ok: true; plugin: InstalledPlugin } | { ok: false; error: HubErrorShape }> {
  const sourcePath = absolutePathOf(input.sourcePath);
  if (sourcePath === undefined) {
    return { ok: false, error: hubError("invalid_input", `invalid plugin source: ${String(input.sourcePath)}`) };
  }
  const candidate = await inspectPluginSource(sourcePath);
  if (candidate.state === "blocked") {
    return { ok: false, error: hubError("invalid_input", `invalid plugin source: ${candidate.problem}`) };
  }
  const name = candidate.manifest.name;
  const vendorRoot = vendorRootOf(input.agentDir);
  const targetDir = join(vendorRoot, name);
  const existed = await lstat(targetDir).catch(() => undefined);
  if (existed !== undefined && input.overwrite !== true) {
    return { ok: false, error: hubError("name_conflict", `plugin already installed: ${name} (pass overwrite: true to replace)`) };
  }
  const pluginsRoot = join(input.agentDir, "plugins");
  const tmpBase = join(pluginsRoot, ".tmp");
  const tmpInfo = await lstat(tmpBase).catch(() => undefined);
  if (tmpInfo !== undefined && !tmpInfo.isDirectory()) {
    return { ok: false, error: hubError("io_failed", `plugin import temp path is not a directory: ${tmpBase}`) };
  }
  const staging = join(tmpBase, `plugin-import-${randomUUID()}`);
  try {
    await mkdir(vendorRoot, { recursive: true });
    const state: CopyState = { bytes: 0, entries: 0, skipped: 0 };
    await copyTree(sourcePath, staging, state);
    // 就位树哈希（pin 基准 = 被装载的字节）
    const sha256 = await hashTree(staging);
    await placeStaged(staging, targetDir, tmpBase);
    await updateVendorRegistry(input.agentDir, (current) => [
      ...current.filter((entry) => entry.name !== name),
      {
        name,
        dir: name,
        sha256,
        approvedBy: "user" as const,
        approvedAt: Date.now(),
        apiVersion: candidate.manifest.apiVersion,
        origin: input.origin ?? "manual",
        ...(candidate.manifest.description !== undefined ? { description: candidate.manifest.description } : {}),
      },
    ]);
    return { ok: true, plugin: { name, path: targetDir, sha256, skippedEntries: state.skipped } };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
}

/** 移除：vendor 目录 + registry 条目（不触碰装载中的 world——热卸是另一命令的事） */
export async function removePlugin(input: { name?: unknown; agentDir: string }): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  const name = typeof input.name === "string" ? input.name : "";
  if (!isPluginName(name)) {
    return { ok: false, error: hubError("invalid_input", `invalid plugin name: ${String(input.name)}`) };
  }
  const targetDir = join(vendorRootOf(input.agentDir), name);
  const existed = await lstat(targetDir).catch(() => undefined);
  if (existed === undefined) {
    return { ok: false, error: hubError("state_conflict", `unknown plugin: ${name}`) };
  }
  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: errorOfCause(error, "io_failed") };
  }
  await updateVendorRegistry(input.agentDir, (current) => current.filter((entry) => entry.name !== name));
  return { ok: true };
}

/** 装载入口文件探测：manifest.entry 缺省 index.ts（worker boot 的 pluginPath） */
export async function pluginEntryPath(vendorRoot: string, entry: VendorPluginEntry): Promise<string | undefined> {
  const manifestFile = join(vendorRoot, entry.dir, "plugin.json");
  const manifest = await readManifest(join(vendorRoot, entry.dir));
  void manifestFile;
  const rel = typeof (manifest as { entry?: unknown } | null)?.["entry"] === "string"
    ? ((manifest as { entry: string }).entry)
    : "index.ts";
  const file = join(vendorRoot, entry.dir, rel);
  const info = await lstat(file).catch(() => undefined);
  return info !== undefined && info.isFile() ? file : undefined;
}
