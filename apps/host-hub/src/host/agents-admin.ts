// agents 类型管理面（DESIGN §3.8）：create（frontmatter 严格集渲染——round-trip
// 复析保证：description 拒换行与字段形态行、systemPrompt 空串拒；写
// <~/.x-harness/agents>/<name>.md；同名 user 文件拒）/ remove（现扫定 source，
// user 才删）。frontmatter = x-harness delegation 装载格式（name/description/
// model/tools + body）。
import { homedir } from "node:os";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { loadAgentTypes } from "@x-harness/agent-delegation";
import { hubError, type HubErrorShape } from "../shared/errors.ts";

/** homeDir 注入缝：缺省真实 HOME；测试注入隔离目录（bun 的 os.homedir() 启动即缓存，
 *  进程内 HOME 重定向无效——与本文件直调的进程内测试配套）。 */
export function userAgentsDirOf(homeDir: string = homedir()): string {
  return join(homeDir, ".x-harness", "agents");
}

/** frontmatter 字段形态行（防 description/systemPrompt 注入 frontmatter 结构） */
const FIELD_LINE = /^[a-zA-Z-]+:/;

/** 渲染 → 复析等价（round-trip：字段集封闭 + 值不含换行/形态行——恒 invalid_input 族） */
function renderAgentType(spec: { name: string; description: string; systemPrompt: string; model?: string; tools?: string[] }): { ok: true; text: string } | { ok: false; error: HubErrorShape } {
  if (spec.description.includes("\n") || FIELD_LINE.test(spec.description)) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: description must be a single line without field-like prefix") };
  }
  if (spec.systemPrompt.trim() === "") {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: systemPrompt required") };
  }
  if (spec.model !== undefined && (spec.model.includes("\n") || spec.model.trim() === "")) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: model must be a single non-empty line") };
  }
  if (spec.tools !== undefined && (!Array.isArray(spec.tools) || spec.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: tools must be an array of non-empty strings") };
  }
  const head = [
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    ...(spec.model !== undefined ? [`model: ${spec.model}`] : []),
    ...(spec.tools !== undefined && spec.tools.length > 0 ? [`tools: ${spec.tools.join(",")}`] : []),
  ].join("\n");
  return { ok: true, text: `---\n${head}\n---\n\n${spec.systemPrompt}\n` };
}

/** 入参提取 + 词法校验（复杂度拆分——addModel 同法；恒 invalid_input 族） */
function agentTypeSpecOf(input: { [key: string]: unknown }): { ok: true; spec: { name: string; description: string; systemPrompt: string; model?: string; tools?: string[] } } | { ok: false; error: HubErrorShape } {
  const name = typeof input.name === "string" ? input.name : "";
  const description = typeof input.description === "string" ? input.description : "";
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
  const tools = Array.isArray(input.tools) ? (input.tools as unknown[]).filter((tool): tool is string => typeof tool === "string" && tool !== "") : undefined;
  if (name.trim() === "" || name.includes("/") || name.includes("\n")) {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: name must be a non-empty path-free string") };
  }
  if (description.trim() === "") {
    return { ok: false, error: hubError("invalid_input", "invalid agent type: description required") };
  }
  return { ok: true, spec: { name, description, systemPrompt, ...(model !== undefined ? { model } : {}), ...(tools !== undefined && tools.length > 0 ? { tools } : {}) } };
}

export async function createUserAgentType(input: { [key: string]: unknown }, homeDir?: string): Promise<{ ok: true; path: string } | { ok: false; error: HubErrorShape }> {
  const spec = agentTypeSpecOf(input);
  if (!spec.ok) return spec;
  const { name } = spec.spec;
  const rendered = renderAgentType(spec.spec);
  if (!rendered.ok) return rendered;
  // round-trip 复析：渲染产物必须能被装载器读回同名类型（保证用户拿到的文件可用）
  const path = join(userAgentsDirOf(homeDir), `${name}.md`);
  const existing = await loadAgentTypes([userAgentsDirOf(homeDir)]);
  if (existing.types[name] !== undefined) {
    return { ok: false, error: hubError("name_conflict", `agent type already exists: ${name}`) };
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(userAgentsDirOf(homeDir), { recursive: true });
  await writeFile(path, rendered.text, "utf8");
  const reloaded = await loadAgentTypes([userAgentsDirOf(homeDir)]);
  if (reloaded.types[name] === undefined) {
    await rm(path, { force: true }).catch(() => undefined);
    return { ok: false, error: hubError("invalid_input", "invalid agent type: rendered file failed round-trip parse") };
  }
  return { ok: true, path };
}

export async function removeUserAgentType(name: string, homeDir?: string): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  // 判据 = user 文件本身在不在（与 create 同口径）：user 级同名 builtin 是合法遮蔽
  // （create 只扫 user 目录不拒 builtin 名）——遮蔽档可删，删后 builtin 恢复可见；
  // user 文件不在且 builtin 在 = builtin 档不可删（随包事实）
  const userDir = userAgentsDirOf(homeDir);
  const loaded = await loadAgentTypes([userDir]);
  if (loaded.types[name] === undefined) {
    const { builtinTypesDir } = await import("../worker/assembly.ts");
    const builtin = loadAgentTypes([builtinTypesDir()]);
    if (builtin.types[name] !== undefined) {
      return { ok: false, error: hubError("state_conflict", `agent type not user-defined: ${name}`) };
    }
    return { ok: false, error: hubError("state_conflict", `unknown agent type: ${name}`) };
  }
  await rm(join(userDir, `${name}.md`), { force: true });
  return { ok: true };
}
