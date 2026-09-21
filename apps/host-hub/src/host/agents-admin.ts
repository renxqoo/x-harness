// agents 类型管理面（DESIGN §3.8）：create（frontmatter 严格集渲染——round-trip
// 复析保证：description 拒换行与字段形态行、systemPrompt 空串拒；写
// <~/.x-harness/agents>/<name>.md；同名 user 文件拒）/ remove（现扫定 source，
// user 才删）。frontmatter = x-harness delegation 装载格式（name/description/
// model/tools + body）。
import { homedir } from "node:os";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { loadAgentTypes } from "@x-harness/agent-delegation";

function userAgentsDir(): string {
  return join(homedir(), ".x-harness", "agents");
}

/** frontmatter 字段形态行（防 description/systemPrompt 注入 frontmatter 结构） */
const FIELD_LINE = /^[a-zA-Z-]+:/;

/** 渲染 → 复析等价（round-trip：字段集封闭 + 值不含换行/形态行） */
function renderAgentType(spec: { name: string; description: string; systemPrompt: string; model?: string; tools?: string[] }): { ok: true; text: string } | { ok: false; error: string } {
  if (spec.description.includes("\n") || FIELD_LINE.test(spec.description)) {
    return { ok: false, error: "invalid agent type: description must be a single line without field-like prefix" };
  }
  if (spec.systemPrompt.trim() === "") {
    return { ok: false, error: "invalid agent type: systemPrompt required" };
  }
  if (spec.model !== undefined && (spec.model.includes("\n") || spec.model.trim() === "")) {
    return { ok: false, error: "invalid agent type: model must be a single non-empty line" };
  }
  if (spec.tools !== undefined && (!Array.isArray(spec.tools) || spec.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
    return { ok: false, error: "invalid agent type: tools must be an array of non-empty strings" };
  }
  const head = [
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    ...(spec.model !== undefined ? [`model: ${spec.model}`] : []),
    ...(spec.tools !== undefined && spec.tools.length > 0 ? [`tools: ${spec.tools.join(",")}`] : []),
  ].join("\n");
  return { ok: true, text: `---\n${head}\n---\n\n${spec.systemPrompt}\n` };
}

/** 入参提取 + 词法校验（复杂度拆分——addModel 同法） */
function agentTypeSpecOf(input: { [key: string]: unknown }): { ok: true; spec: { name: string; description: string; systemPrompt: string; model?: string; tools?: string[] } } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name : "";
  const description = typeof input.description === "string" ? input.description : "";
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
  const tools = Array.isArray(input.tools) ? (input.tools as unknown[]).filter((tool): tool is string => typeof tool === "string" && tool !== "") : undefined;
  if (name.trim() === "" || name.includes("/") || name.includes("\n")) {
    return { ok: false, error: "invalid agent type: name must be a non-empty path-free string" };
  }
  if (description.trim() === "") {
    return { ok: false, error: "invalid agent type: description required" };
  }
  return { ok: true, spec: { name, description, systemPrompt, ...(model !== undefined ? { model } : {}), ...(tools !== undefined && tools.length > 0 ? { tools } : {}) } };
}

export async function createUserAgentType(input: { [key: string]: unknown }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const spec = agentTypeSpecOf(input);
  if (!spec.ok) return spec;
  const { name } = spec.spec;
  const rendered = renderAgentType(spec.spec);
  if (!rendered.ok) return rendered;
  // round-trip 复析：渲染产物必须能被装载器读回同名类型（保证用户拿到的文件可用）
  const path = join(userAgentsDir(), `${name}.md`);
  const existing = await loadAgentTypes([userAgentsDir()]);
  if (existing.types[name] !== undefined) {
    return { ok: false, error: `agent type already exists: ${name}` };
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(userAgentsDir(), { recursive: true });
  await writeFile(path, rendered.text, "utf8");
  const reloaded = await loadAgentTypes([userAgentsDir()]);
  if (reloaded.types[name] === undefined) {
    await rm(path, { force: true }).catch(() => undefined);
    return { ok: false, error: "invalid agent type: rendered file failed round-trip parse" };
  }
  return { ok: true, path };
}

export async function removeUserAgentType(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { builtinTypesDir } = await import("../worker/assembly.ts");
  const builtin = loadAgentTypes([builtinTypesDir()]);
  if (builtin.types[name] !== undefined) {
    return { ok: false, error: `agent type not user-defined: ${name}` }; // builtin 档不可删（随包事实）
  }
  const loaded = await loadAgentTypes([userAgentsDir()]);
  if (loaded.types[name] === undefined) {
    return { ok: false, error: `unknown agent type: ${name}` };
  }
  await rm(join(userAgentsDir(), `${name}.md`), { force: true });
  return { ok: true };
}
