import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { LoadedAgentType } from "./types.ts";
import { splitDialRef } from "./lineage.ts";

export interface TypeLoadResult {
  readonly types: Readonly<Record<string, LoadedAgentType>>;
  readonly warnings: readonly string[];
}

const RESERVED = new Set(["fork", "main"]);

export function userAgentsDirOf(homeDir: string = homedir(), agentDir?: string): string {
  if (agentDir !== undefined && agentDir !== "") return join(agentDir, "agents");
  return join(homeDir, ".x-harness", "agents");
}

export function projectAgentsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "agents");
}

export function resolveAgentDirs(configured?: readonly string[]): readonly string[] {
  if (configured !== undefined && configured.length > 0) return [...configured];
  const env = process.env["X_HARNESS_AGENTS_DIRS"];
  if (env !== undefined && env !== "") return env.split(":").filter((dir) => dir !== "");
  return [projectAgentsDirOf(process.cwd()), userAgentsDirOf()];
}

export function typesFingerprint(dirs: readonly string[]): string {
  const marks: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort()) {
      let mtime = "-";
      try {
        mtime = String(statSync(join(dir, entry)).mtimeMs);
      } catch {
      }
      marks.push(`${dir}/${entry}:${mtime}`);
    }
  }
  return marks.join("|");
}

export function loadAgentTypes(dirs: readonly string[]): TypeLoadResult {
  const types: Record<string, LoadedAgentType> = {};
  const warnings: string[] = [];
  for (const dir of [...dirs].reverse()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stem = entry.name.slice(0, -".md".length);
      const loaded = parseFile(join(dir, entry.name), stem);
      if (typeof loaded === "string") {
        warnings.push(loaded);
        continue;
      }
      types[stem] = loaded;
    }
  }
  return { types, warnings };
}

function dialFieldsOf(fields: ReadonlyMap<string, string>): { model?: string; provider?: string } {
  const rawModel = fields.get("model");
  const composite = rawModel !== undefined ? splitDialRef(rawModel) : undefined;
  return {
    ...(composite?.model ?? rawModel !== undefined ? { model: composite?.model ?? rawModel } : {}),
    ...(fields.get("provider") ?? composite?.provider !== undefined ? { provider: fields.get("provider") ?? composite?.provider } : {}),
  };
}

type ParseOutcome = LoadedAgentType | string;

function parseFile(path: string, stem: string): ParseOutcome {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return `agents: unreadable ${path} (${(error as { code?: string }).code ?? "io"})`;
  }
  const matter = splitFrontmatter(text);
  if (matter === undefined) return `agents: ${path} has no frontmatter`;
  const fields = parseFlat(matter.head);
  if (fields === undefined) return `agents: ${path} frontmatter is not flat key: value lines`;
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return `agents: ${path} missing required name/description`;
  if (name !== stem) return `agents: ${path} name '${name}' must match filename '${stem}'`;
  if (RESERVED.has(name)) return `agents: ${path} reserved type name '${name}'`;
  const tools = fields.get("tools");
  const { model, provider } = dialFieldsOf(fields);
  const type: LoadedAgentType = {
    name,
    description,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(tools !== undefined ? { tools: tools.split(",").map((t) => t.trim()).filter((t) => t !== "") } : {}),
    prompt: matter.body,
  };
  return type;
}
