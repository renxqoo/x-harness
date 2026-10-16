import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readData } from "../../core/src/validation";
import type { Result } from "../../core/src/index";
import type { CreateProjectOptions, CreateProjectFault, ProjectConfig } from "./types";
import { projectFault } from "./project-fault";

export async function readProjectOptions(options: CreateProjectOptions): Promise<Result<ProjectConfig, CreateProjectFault>> {
  const read = readData(options);
  if (!read.ok || Object.keys(read.value).some((key) => !["directory", "name", "sdk"].includes(key))) return projectFault("invalid-input");
  const data = read.value;
  if (typeof data.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(data.name) || typeof data.directory !== "string" || !isAbsolute(data.directory) ||
      data.directory.length > 4096 || data.directory.includes("\0") || (data.sdk !== undefined && (typeof data.sdk !== "string" || !isAbsolute(data.sdk)))) return projectFault("invalid-input");
  try {
    const name = basename(data.directory); if (!name || name === "." || name === ".." || data.directory.endsWith("/")) return projectFault("invalid-input");
    const parent = await realpath(dirname(data.directory)); const sdk = await realpath(data.sdk as string | undefined ?? fileURLToPath(new URL("../../", import.meta.url)));
    if (!(await stat(join(sdk, "core/src/index.ts"))).isFile() || !(await stat(join(sdk, "application/src/index.ts"))).isFile()) return projectFault("invalid-input");
    const compiler = join(dirname(Bun.resolveSync("typescript/package.json", sdk)), "bin/tsc"); const types = join(dirname(Bun.resolveSync("bun-types/package.json", sdk)), "index.d.ts");
    return { ok: true, value: { directory: join(parent, name), name: data.name, sdk, compiler, types } };
  } catch { return projectFault("invalid-input"); }
}
