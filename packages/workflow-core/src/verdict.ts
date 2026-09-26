// 裁决器（docs/AGENT-WORKFLOW.md §8.1 纯函数半）：证据 → Verdict、预算扣减、组合器。
// 采集器（async，插件层）不在本包——这里只裁决已采集的证据。

import type { BudgetState, TierKind, Verdict } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";

/** 证据（采集器产出——形态按档闭合） */
export type Evidence =
  | { readonly kind: "schema"; readonly extracted?: unknown; readonly violations: readonly string[] }
  | { readonly kind: "command"; readonly exitCode: number | undefined; readonly output: string }
  | { readonly kind: "critic"; readonly verdict?: "pass" | "fail"; readonly reopenProposals?: readonly string[]; readonly summary?: string };

/** 单档裁决：证据 → Verdict（预算未耗尽时 reject 可回炉，耗尽即 fail） */
/** 单档裁决入参（adjudicate 的计划对象——复杂度/参数纪律） */
export interface AdjudicatePlan {
  readonly tier: TierKind;
  readonly evidence: Evidence;
  readonly budget: BudgetState;
  readonly used: { readonly repairs: number; readonly reopens: number };
}

export function adjudicate(plan: AdjudicatePlan): Verdict {
  const { tier, evidence, budget, used } = plan;
  if (evidence.kind !== tier) return { kind: "fail", reason: `evidence kind '${evidence.kind}' does not match tier '${tier}'` };
  const verdict = evidenceOf(evidence);
  if (verdict.kind === "accept") return verdict;
  // reject 路径的预算判定（fail 路径直接终局）
  const budgetFor = evidence.kind === "critic" ? budget.reopens - used.reopens : budget.repairs - used.repairs;
  if (budgetFor <= 0) return { kind: "fail", reason: failReason(evidence, evidence.kind) };
  return verdict;
}

function evidenceOf(evidence: Evidence): Verdict {
  switch (evidence.kind) {
    case "schema":
      if (evidence.extracted === undefined) return { kind: "reject", violations: ["no extractable structured payload in the final message"] };
      if (evidence.violations.length === 0) return { kind: "accept" };
      return { kind: "reject", violations: evidence.violations };
    case "command":
      if (evidence.exitCode === 0) return { kind: "accept" };
      return { kind: "reject", violations: [`command exited with code ${String(evidence.exitCode)}`] };
    case "critic":
      if (evidence.verdict === undefined) return { kind: "reject", violations: ["critic returned no verdict"] };
      if (evidence.verdict === "pass") return { kind: "accept" };
      if (evidence.reopenProposals === undefined || evidence.reopenProposals.length === 0) return { kind: "reject", violations: ["critic rejected without reopen proposals"] };
      return { kind: "reject", violations: evidence.reopenProposals };
  }
}

function failReason(evidence: Evidence, tier: TierKind): string {
  let detail: string;
  if (evidence.kind === "schema") detail = evidence.violations.length > 0 ? evidence.violations.join("; ") : "no structured payload";
  else if (evidence.kind === "command") detail = `command exited ${String(evidence.exitCode)}`;
  else detail = evidence.summary ?? "critic rejected";
  return `budget exhausted for tier '${tier}': ${detail}`;
}

/** 组合器（§8.2 B+C 链）：顺序裁决，任一 fail 即终局；全 accept 才 accept；
 *  reject 取首个（反馈注明档名由铸文层做——这里保持结构化） */
/** 组合链入参 */
export interface ChainPlan {
  readonly tiers: readonly TierKind[];
  readonly evidenceOfTier: (tier: TierKind) => Evidence | undefined;
  readonly budget?: BudgetState;
  readonly used?: { readonly repairs: number; readonly reopens: number };
}

export function adjudicateChain(plan: ChainPlan): Verdict {
  const budget = plan.budget ?? DEFAULT_BUDGET;
  const used = plan.used ?? { repairs: 0, reopens: 0 };
  for (const tier of plan.tiers) {
    const evidence = plan.evidenceOfTier(tier);
    if (evidence === undefined) continue; // 档未配置（采集器缺席）
    const verdict = adjudicate({ tier, evidence, budget, used });
    if (verdict.kind !== "accept") return verdict;
  }
  return { kind: "accept" };
}

// ————————————————————————— Tier A 载荷抽取与宽松归一（§8.2——ZCode 同款容忍） —————————————————————————

/** 结构化载荷抽取：终态文本 → JSON 候选；失败返回 undefined（裁决层铸「无可抽取」违规）。
 *  宽松归一（单次不递归）：文本先原样 parse；失败时剥代码围栏再 parse 一次。 */
export function extractPayload(finalText: string): unknown | undefined {
  const direct = parseJson(finalText.trim());
  if (direct !== undefined) return direct;
  const fenced = stripCodeFence(finalText);
  return fenced === undefined ? undefined : parseJson(fenced.trim());
}

function parseJson(text: string): unknown | undefined {
  if (text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** 剥 markdown 代码围栏（```json ... ``` / ``` ... ```）——返回内层或 undefined */
export function stripCodeFence(text: string): string | undefined {
  const match = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  return match?.[1];
}

// ————————————————————————— 子集校验器（Tier A——TypeBox 之外的独立实现，core 零依赖） —————————————————————————

export interface Violation {
  readonly path: string;
  readonly expected: string;
}

/** JSON Schema 子集校验（type/required/properties/items/enum/minLength——覆盖 result_schema
 *  的常用形态；超集语法忽略不拒——宽松裁决，违规描述指向模型可修改的值） */
export function validateSubset(schema: unknown, value: unknown, path = "$"): readonly Violation[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const violations: Violation[] = [...scalarViolations(s, value, path)];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    violations.push(...objectViolations(s, value as Record<string, unknown>, path));
  }
  if (Array.isArray(value) && s["items"] !== undefined) {
    value.forEach((item, index) => violations.push(...validateSubset(s["items"], item, `${path}[${String(index)}]`)));
  }
  return violations;
}

/** 标量面：type / enum / minLength（对象与数组面之外） */
function scalarViolations(s: Record<string, unknown>, value: unknown, path: string): readonly Violation[] {
  const out: Violation[] = [];
  if (typeof s["type"] === "string" && !typeMatches(s["type"], value)) {
    out.push({ path, expected: `${String(s["type"])} (got ${typeName(value)})` });
  }
  if (Array.isArray(s["enum"])) {
    const violation = enumViolation(s["enum"] as readonly unknown[], value, path);
    if (violation !== undefined) out.push(violation);
  }
  if (typeof s["minLength"] === "number" && typeof value === "string" && value.length < s["minLength"]) {
    out.push({ path, expected: `length >= ${String(s["minLength"])} (got ${String(value.length)})` });
  }
  return out;
}

function enumViolation(enumValues: readonly unknown[], value: unknown, path: string): Violation | undefined {
  const hit = enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
  return hit ? undefined : { path, expected: `one of ${JSON.stringify(enumValues)} (got ${JSON.stringify(value)})` };
}

function objectViolations(s: Record<string, unknown>, value: Record<string, unknown>, path: string): readonly Violation[] {
  const out: Violation[] = [];
  const required = Array.isArray(s["required"]) ? (s["required"] as readonly unknown[]) : [];
  for (const key of required) {
    if (typeof key === "string" && !Object.hasOwn(value, key)) out.push({ path: `${path}.${key}`, expected: "required property present" });
  }
  const properties = s["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return out;
  for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
    const child = value[key];
    if (child !== undefined) out.push(...validateSubset(sub, child, `${path}.${key}`));
  }
  return out;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true; // 未知类型名宽松（超集语法忽略）
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
