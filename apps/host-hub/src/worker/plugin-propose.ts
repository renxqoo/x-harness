// agent 动态注册插件工具（plugin-runtime §5）：plugin_propose——agent 把写好的
// 插件源目录登记为受信候选（哈希源树），发 ui_request confirm 请用户批准。
// 两道门不变式：
// ① propose 只产数据（trustedSources 暂存 + 确认请求）——不触碰装载面；
// ② 唯一执行口 pluginManagerService.install 的门（roots/approveInstall/引擎 P1）
//   在 x-harness 侧，agent 与本工具都改不动。
// 用户确认后由 UI 发 plugins/install（origin:"agent" + proposalId 落账）→ 热装。
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
  /** confirm 结果落账（一次性消费——install 校验） */
  confirmed: boolean;
  consumed: boolean;
}

export interface PluginProposeDeps {
  /** 用户确认桥（ui_request confirm；超时/拒绝 = allowed:false） */
  readonly confirm: (fields: { tool: string; reason: string; options?: readonly string[] }) => Promise<{ allowed: boolean }>;
  /** 提案登记面（host-hub 侧 shared 面注入——暂存与查询单一真相） */
  readonly record: (proposal: PluginProposalRecord) => Promise<void>;
  /** 哈希上限防御（字节累计；缺省 8MiB——manifest+源码远小于此） */
  readonly maxHashBytes?: number;
}

/** 源树内容指纹（路径 + 字节规范化序——与 plugins-install hashTree 同构但不耦合） */
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


/** manifest 展示面快照（坏 manifest 降级 undefined——形态门在 install 的 inspect） */
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

/** 确认请求铸文（P2 语义：能力授予明示） */
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

/** propose 执行体（validate → hash → 登记 → confirm → 应答） */
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
  // 先登记（未确认态），再发确认——confirm 应答即用户裁决（置位由 host confirm 命令面）
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
