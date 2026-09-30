import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolOutcome } from "@x-harness/tools";

const proposeSchema = Type.Object({
  sourcePath: Type.String({ description: "Absolute path to the plugin source directory (must contain plugin.json and the entry file). You usually create this under the current working directory." }),
  name: Type.Optional(Type.String({ description: "Plugin name as declared in plugin.json (defaults to the manifest name; shown to the user in the approval prompt)." })),
  description: Type.Optional(Type.String({ description: "One-line human-readable summary of what this plugin does (shown in the approval prompt)." })),
  requestedCapabilities: Type.Optional(Type.Array(Type.String(), { description: "Platform capabilities the plugin intends to use (declared for audit; e.g. [\"session\", \"tools\"])." })),
});

export interface PluginProposalRecord {
  readonly proposalId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly description: string;
  readonly requestedCapabilities: readonly string[];
  readonly sha256: string;
  readonly createdAt: number;
  confirmed: boolean;
  consumed: boolean;
}

export interface PluginProposeDeps {
  readonly confirm: (fields: { tool: string; reason: string; options?: readonly string[] }) => Promise<{ allowed: boolean }>;
  readonly record: (proposal: PluginProposalRecord) => Promise<void>;
  readonly maxHashBytes?: number;
}

async function hashSourceTree(root: string, budget: number): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
        continue;
      }
      files.push(join(dir.slice(root.length + 1), entry.name));
    }
  };
  try {
    await walk(root);
  } catch (error) {
    return { ok: false, reason: `source unreadable: ${String(error)}` };
  }
  files.sort();
  let bytes = 0;
  for (const rel of files) {
    const content = await readFile(join(root, rel));
    bytes += content.length + rel.length;
    if (bytes > budget) return { ok: false, reason: `source tree too large to register (over ${budget} bytes)` };
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { ok: true, sha256: hash.digest("hex") };
}

export function createPluginProposePlugin(deps: PluginProposeDeps): Plugin {
  return {
    name: "plugin-propose",
    inject: ["tools"],
    apply: (ctx: Context): Disposer => {
      const registry = ctx.use(toolRegistry);
      const off = registry.register({
        name: "plugin_propose",
        description:
          "Register a third-party plugin you wrote (source directory under the current workspace) for user approval. Approval is required before installation: the user sees the plugin name, description, requested capabilities, and a content hash, then confirms in the UI. This tool never installs anything by itself.",
        inputSchema: proposeSchema,
        execute: async (args) => proposeExecute(deps, args as Static<typeof proposeSchema>),
      });
      return off;
    },
  };
}


async function manifestSnapshot(sourcePath: string): Promise<{ name?: string; description?: string }> {
  const raw = await readFile(join(sourcePath, "plugin.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; description?: unknown };
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
    };
  } catch {
    return {};
  }
}

function confirmReason(fields: { name: string; description: string; sourcePath: string; sha256: string; requestedCapabilities: readonly string[] }): string {
  return [
    `Install plugin "${fields.name}"?`,
    fields.description !== "" ? `Description: ${fields.description}` : undefined,
    `Source: ${fields.sourcePath}`,
    `Content hash (sha256): ${fields.sha256}`,
    fields.requestedCapabilities.length > 0 ? `Requested capabilities: ${fields.requestedCapabilities.join(", ")}` : undefined,
    "Confirming grants the plugin full platform capabilities (sessions, tools, system prompt, model runtime) after installation.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function proposeExecute(deps: PluginProposeDeps, args: Static<typeof proposeSchema>): Promise<ToolOutcome> {
  const sourcePath = args.sourcePath;
  if (!sourcePath.startsWith("/")) {
    return { content: "invalid-args:sourcePath must be an absolute path", isError: true };
  }
  const info = await lstat(sourcePath).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    return { content: `invalid-args:sourcePath is not a directory: ${sourcePath}`, isError: true };
  }
  const manifest = await manifestSnapshot(sourcePath);
  const hashed = await hashSourceTree(sourcePath, deps.maxHashBytes ?? 8 * 1024 * 1024);
  if (!hashed.ok) return { content: `invalid-args:${hashed.reason}`, isError: true };
  const name = args.name ?? manifest.name ?? sourcePath.split("/").filter(Boolean).pop() ?? "";
  const description = args.description ?? manifest.description ?? "";
  const requestedCapabilities = args.requestedCapabilities ?? [];
  const proposalId = `pp-${Date.now().toString(36)}-${hashed.sha256.slice(0, 8)}`;
  await deps.record({
    proposalId,
    sourcePath,
    name,
    description,
    requestedCapabilities,
    sha256: hashed.sha256,
    createdAt: Date.now(),
    confirmed: false,
    consumed: false,
  });
  const answer = await deps.confirm({
    tool: "plugin_propose",
    reason: confirmReason({ name, description, sourcePath, sha256: hashed.sha256, requestedCapabilities }),
    options: ["Allow once", "Deny"],
  });
  if (!answer.allowed) {
    return { content: `rejected:user denied the plugin proposal (${proposalId}); the plugin is NOT installed` };
  }
  return {
    content: [
      `pending_install: proposal ${proposalId} approved by the user.`,
      "The host will install it into the vendor root and hot-load it into live sessions.",
      "You cannot install plugins yourself — wait for the installation to complete (check via the UI or ask the user).",
    ].join("\n"),
  };
}
