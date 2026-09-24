// agents 类型管理面（DESIGN §3.8）：create（frontmatter 严格集渲染——round-trip
// 复析保证：description 拒换行与字段形态行、systemPrompt 空串拒；写用户根
// <name>.md；同名 user 文件拒）/ remove（现扫定 source，user 才删）。frontmatter =
// x-harness delegation 装载格式（name/description/model/tools + body）。
// 目录约定单源 @x-harness/agent-delegation（agentDir 派生缝在场时用户根 =
// <agentDir>/agents——与 worker 装配/agents-list 同源；缺省 ~/.x-harness/agents）。
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { loadAgentTypes, userAgentsDirOf } from "@x-harness/agent-delegation";
import { hubError, type HubErrorShape } from "../shared/errors.ts";

/** frontmatter 字段形态行（防 description/systemPrompt 注入 frontmatter 结构） */
const FIELD_LINE = /^[a-zA-Z-]+:/;

/** 入参可选字符串提取（空串归 undefined = 不写该字段） */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 入参工具白名单提取（非数组归 undefined；空串成员滤除） */
function optionalTools(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as unknown[]).filter((tool): tool is string => typeof tool === "string" && tool !== "") : undefined;
}

/** 单行非空标量校验（model/provider 共用——恒 invalid_input 族；provider 额外拒 `/`） */
function invalidScalar(field: string, value: string, extra?: { noSlash?: boolean }): string | undefined {
  if (value.includes("\n") || value.trim() === "") return `invalid agent type: ${field} must be a single non-empty line`;
  if (extra?.noSlash === true && value.includes("/")) return `invalid agent type: ${field} must be a single non-empty line without '/'`;
  return undefined;
}

/** 渲染 → 复析等价（round-trip：字段集封闭 + 值不含换行/形态行——恒 invalid_input 族） */
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

/** 入参提取 + 词法校验（复杂度拆分——addModel 同法；恒 invalid_input 族） */
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

/** 目录解析（homeDir/agentDir 双注入缝——agentDir 在场时优先，与 worker 装配同序） */
function userDirOf(homeDir?: string, agentDir?: string): string {
  return userAgentsDirOf(homeDir, agentDir);
}

export async function createUserAgentType(input: { [key: string]: unknown }, homeDir?: string, agentDir?: string): Promise<{ ok: true; path: string } | { ok: false; error: HubErrorShape }> {
  const spec = agentTypeSpecOf(input);
  if (!spec.ok) return spec;
  const { name } = spec.spec;
  const rendered = renderAgentType(spec.spec);
  if (!rendered.ok) return rendered;
  // round-trip 复析：渲染产物必须能被装载器读回同名类型（保证用户拿到的文件可用）
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
  // 判据 = user 文件本身在不在（与 create 同口径）：user 级同名 builtin 是合法遮蔽
  // （create 只扫 user 目录不拒 builtin 名）——遮蔽档可删，删后 builtin 恢复可见；
  // user 文件不在且 builtin 在 = builtin 档不可删（随包事实）
  const userDir = userDirOf(homeDir, agentDir);
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
