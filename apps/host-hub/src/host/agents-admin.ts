import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { loadAgentTypes, userAgentsDirOf } from "@x-harness/agent-delegation";
import { hubError, type HubErrorShape } from "../shared/errors.ts";

const FIELD_LINE = /^[a-zA-Z-]+:/;

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalTools(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as unknown[]).filter((tool): tool is string => typeof tool === "string" && tool !== "") : undefined;
}

function invalidScalar(field: string, value: string, extra?: { noSlash?: boolean }): string | undefined {
  if (value.includes("\n") || value.trim() === "") return `invalid agent type: ${field} must be a single non-empty line`;
  if (extra?.noSlash === true && value.includes("/")) return `invalid agent type: ${field} must be a single non-empty line without '/'`;
  return undefined;
}

function renderAgentType(spec: { name: string; description: string; systemPrompt: string; model?: string; provider?: string; tools?: string[] }): { ok: true; text: string } | { ok: false; error: HubErrorShape } {
  if (spec.description.includes("\n") || FIELD_LINE.test(spec.description)) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: description must be a single line without field-like prefix") };
  }
  if (spec.systemPrompt.trim() === "") {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: systemPrompt required") };
  }
  for (const [field, value, extra] of [
    ["model", spec.model],
    ["provider", spec.provider, { noSlash: true }],
  ] as const) {
    if (value === undefined) continue;
    const invalid = invalidScalar(field, value, extra);
    if (invalid !== undefined) return { ok: false, error: hubError("invalid_input", invalid) };
  }
  if (spec.tools !== undefined && (!Array.isArray(spec.tools) || spec.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: tools must be an array of non-empty strings") };
  }
  const head = [
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    ...(spec.model !== undefined ? [`model: ${spec.model}`] : []),
    ...(spec.provider !== undefined ? [`provider: ${spec.provider}`] : []),
    ...(spec.tools !== undefined && spec.tools.length > 0 ? [`tools: ${spec.tools.join(",")}`] : []),
  ].join("\n");
  return { ok: true, text: `---\n${head}\n---\n\n${spec.systemPrompt}\n` };
}

function agentTypeSpecOf(input: { [key: string]: unknown }): { ok: true; spec: { name: string; description: string; systemPrompt: string; model?: string; provider?: string; tools?: string[] } } | { ok: false; error: HubErrorShape } {
  const name = typeof input.name === "string" ? input.name : "";
  const description = typeof input.description === "string" ? input.description : "";
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  const model = optionalText(input.model);
  const provider = optionalText(input.provider);
  const tools = optionalTools(input.tools);
  if (name.trim() === "" || name.includes("/") || name.includes("\n")) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: name must be a non-empty path-free string") };
  }
  if (description.trim() === "") {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: description required") };
  }
  return { ok: true, spec: { name, description, systemPrompt, ...(model !== undefined ? { model } : {}), ...(provider !== undefined ? { provider } : {}), ...(tools !== undefined && tools.length > 0 ? { tools } : {}) } };
}

function userDirOf(homeDir?: string, agentDir?: string): string {
  return userAgentsDirOf(homeDir, agentDir);
}

export async function createUserAgentType(input: { [key: string]: unknown }, homeDir?: string, agentDir?: string): Promise<{ ok: true; path: string } | { ok: false; error: HubErrorShape }> {
  const spec = agentTypeSpecOf(input);
  if (!spec.ok) return spec;
  const { name } = spec.spec;
  const rendered = renderAgentType(spec.spec);
  if (!rendered.ok) return rendered;
  const path = join(userDirOf(homeDir, agentDir), `${name}.md`);
  const existing = await loadAgentTypes([userDirOf(homeDir, agentDir)]);
  if (existing.types[name] !== undefined) {
    return { ok: false, error: hubError("name_conflict", `agent type already exists: ${name}`) };
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(userDirOf(homeDir, agentDir), { recursive: true });
  await writeFile(path, rendered.text, "utf8");
  const reloaded = await loadAgentTypes([userDirOf(homeDir, agentDir)]);
  if (reloaded.types[name] === undefined) {
    await rm(path, { force: true }).catch(() => undefined);
    return { ok: false, error: hubError("invalid_input", "invalid agent type: rendered file failed round-trip parse") };
  }
  return { ok: true, path };
}

export async function removeUserAgentType(name: string, homeDir?: string, agentDir?: string): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  const userDir = userDirOf(homeDir, agentDir);
  const loaded = await loadAgentTypes([userDir]);
  if (loaded.types[name] === undefined) {
    const { builtinAgentTypes } = await import("../worker/assembly.ts");
    const { parseInlineTypes } = await import("@x-harness/agent-delegation");
    const builtin = parseInlineTypes(builtinAgentTypes());
    if (builtin.types[name] !== undefined) {
      return { ok: false, error: hubError("state_conflict", `agent type not user-defined: ${name}`) };
    }
    return { ok: false, error: hubError("state_conflict", `unknown agent type: ${name}`) };
  }
  await rm(join(userDir, `${name}.md`), { force: true });
  return { ok: true };
}
