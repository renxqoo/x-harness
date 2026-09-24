// 内置类型内联资源装载（bundle 内联分发形态）：资源文本 → LoadedAgentType——与
// 盘上 .md 同一解析管线（frontmatter 拆分 + flat 解析），垃圾资源 fail-fast 拒注册
// （随包资源是构建产物——垃圾即构建期 bug，不静默）。目录优先级降序「前者胜」语义
// 下，宿主把内联层垫在 agentsDirs 之后（最低优先级）。
import { parseFlat, splitFrontmatter } from "@x-harness/md-frontmatter";
import type { LoadedAgentType } from "./types.ts";
import { splitDialRef } from "./lineage.ts";

const RESERVED = new Set(["fork", "main"]);

export interface InlineTypeResource {
  readonly stem: string;
  readonly text: string;
}

/** model/provider 字段拆解：model 命中复合串 `provider/model` 拆双段；显式 provider 恒胜 */
function dialFieldsOf(fields: ReadonlyMap<string, string>): { model?: string; provider?: string } {
  const rawModel = fields.get("model");
  const composite = rawModel !== undefined ? splitDialRef(rawModel) : undefined;
  return {
    ...(composite?.model ?? rawModel !== undefined ? { model: composite?.model ?? rawModel } : {}),
    ...(fields.get("provider") ?? composite?.provider !== undefined ? { provider: fields.get("provider") ?? composite?.provider } : {}),
  };
}

/** 内联资源解析：单一资源垃圾 → 该类型拒注册并返回告警（不 throw 不崩） */
export function parseInlineType(resource: InlineTypeResource): LoadedAgentType | string {
  const label = `agents: builtin resource '${resource.stem}'`;
  const matter = splitFrontmatter(resource.text);
  if (matter === undefined) return `${label} has no frontmatter`;
  const fields = parseFlat(matter.head);
  if (fields === undefined) return `${label} frontmatter is not flat key: value lines`;
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return `${label} missing required name/description`;
  if (name !== resource.stem) return `${label} name '${name}' must match stem '${resource.stem}'`;
  if (RESERVED.has(name)) return `${label} reserved type name '${name}'`;
  const tools = fields.get("tools");
  const { model, provider } = dialFieldsOf(fields);
  return {
    name,
    description,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(tools !== undefined ? { tools: tools.split(",").map((t) => t.trim()).filter((t) => t !== "") } : {}),
    prompt: matter.body,
  };
}

export function parseInlineTypes(resources: readonly InlineTypeResource[]): { types: Record<string, LoadedAgentType>; warnings: string[] } {
  const types: Record<string, LoadedAgentType> = {};
  const warnings: string[] = [];
  for (const resource of resources) {
    const parsed = parseInlineType(resource);
    if (typeof parsed === "string") {
      warnings.push(parsed);
      continue;
    }
    types[parsed.name] = parsed;
  }
  return { types, warnings };
}
