// sections/variables 注册表（docs/SYSTEM-PROMPT.md §1）：锚点定位代数（after/before，注册期环检测）、
// 同名覆盖（沿用旧注册序）+ 身份守卫注销、{{var}} 单层插值（函数抛错保持原样）、sha256 指纹、排序缓存。

import { createHash } from "node:crypto";
import type { PromptVariable, SectionSpec, SystemPromptService } from "./types.ts";

/** 无边段落尾基座（任何锚点派生位次都小于它——锚链可整体落在无边段之前） */
const TAIL_BASE = 1_000_000;
const DELTA = 0.5;

interface SectionEntry {
  readonly spec: SectionSpec;
  readonly identity: object;
  readonly regIndex: number;
}

export function createPromptRegistry(): SystemPromptService {
  const sections = new Map<string, SectionEntry>();
  const variables = new Map<string, { readonly value: PromptVariable; readonly identity: object }>();
  let regCounter = 0;
  let orderCache: readonly string[] | undefined;

  const anchorOf = (spec: SectionSpec): string | undefined => spec.after ?? spec.before;

  /** 注册期环检测：待注册段视为已在图中——沿锚链 DFS 回到它即环（缺席锚不建边） */
  function wouldCycle(name: string, spec: SectionSpec): boolean {
    const start = anchorOf(spec);
    if (start === undefined) return false;
    const seen = new Set<string>([name]);
    const queue = [start];
    for (;;) {
      const current = queue.pop();
      if (current === undefined) return false;
      if (current === name) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const entry = sections.get(current);
      const anchor = entry === undefined ? undefined : anchorOf(entry.spec);
      if (anchor !== undefined && (anchor === name || sections.has(anchor))) queue.push(anchor);
    }
  }

  function resolveOrder(): readonly string[] {
    // 位次递归（memo；环已在注册期拦截）；anchorChildren 为 before/after 共用的每锚后代计数
    const memo = new Map<string, number>();
    const anchorChildren = new Map<string, number>();
    const orderOf = (name: string): number => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const entry = sections.get(name);
      if (entry === undefined) return TAIL_BASE; // 缺席锚 no-op（目标被注销）：按无边段处理
      const anchor = anchorOf(entry.spec);
      let position: number;
      if (anchor === undefined || !sections.has(anchor)) {
        position = TAIL_BASE + entry.regIndex;
      } else {
        const nth = anchorChildren.get(anchor) ?? 0;
        anchorChildren.set(anchor, nth + 1);
        const sign = entry.spec.after !== undefined ? 1 : -1;
        position = orderOf(anchor) + sign * (DELTA / 2 ** nth);
      }
      memo.set(name, position);
      return position;
    };
    // 预热：按注册序给各段分配位次——δ/2ⁿ 的 n 必须按注册序计数（sort 比较器的惰性求值序
    // 不是注册序，前向引用「子段先于锚注册」会拿错 n）
    for (const name of [...sections.keys()].sort((a, b) => regIndexOf(a) - regIndexOf(b))) orderOf(name);
    return [...sections.keys()].sort((a, b) => orderOf(a) - orderOf(b) || regIndexOf(a) - regIndexOf(b));
  }

  function regIndexOf(name: string): number {
    return sections.get(name)?.regIndex ?? 0;
  }

  return {
    section: (spec: SectionSpec) => {
      const invalid = sectionSpecError(spec);
      if (invalid !== undefined) throw invalid;
      if (wouldCycle(spec.name, spec)) {
        const anchor = anchorOf(spec) as string;
        throw new Error(`section cycle: ${spec.name} -> ${anchor}`);
      }
      const identity = {};
      const previous = sections.get(spec.name);
      sections.set(spec.name, { spec, identity, regIndex: previous?.regIndex ?? regCounter++ });
      orderCache = undefined;
      return () => {
        const current = sections.get(spec.name);
        if (current?.identity === identity) {
          sections.delete(spec.name);
          orderCache = undefined;
        }
      };
    },

    variable: (name: string, value: PromptVariable) => {
      if (typeof name !== "string" || name === "") throw new Error("variable name must be a non-empty string");
      if (typeof value !== "string" && typeof value !== "function") {
        throw new Error(`variable "${name}" value must be a string or function`);
      }
      const identity = {};
      variables.set(name, { value, identity });
      return () => {
        const current = variables.get(name);
        if (current?.identity === identity) variables.delete(name);
      };
    },

    assemble: () => {
      // 排序缓存：段集未变复用；插值与指纹每次现算（变量是惰性闭包，结果不可缓存）
      if (orderCache === undefined) orderCache = resolveOrder();
      const joined = orderCache.map((name) => sections.get(name)?.spec.text ?? "").join("\n\n");
      const text = interpolate(joined, variables);
      return { text, fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 16) };
    },
  };
}

/** 注册参数门：形状/互斥/自锚（装配期错误，与内核 provide 同语义） */
function sectionSpecError(spec: SectionSpec): Error | undefined {
  if (typeof spec?.name !== "string" || spec.name === "") return new Error("section name must be a non-empty string");
  if (spec.after !== undefined && (typeof spec.after !== "string" || spec.after === "")) {
    return new Error(`section "${spec.name}" after must be a non-empty string when present`);
  }
  if (spec.before !== undefined && (typeof spec.before !== "string" || spec.before === "")) {
    return new Error(`section "${spec.name}" before must be a non-empty string when present`);
  }
  if (spec.after !== undefined && spec.before !== undefined) {
    return new Error(`section "${spec.name}" declares both after and before`);
  }
  if (spec.after === spec.name || spec.before === spec.name) {
    return new Error(`section "${spec.name}" cannot anchor to itself`);
  }
  if (typeof spec.text !== "string") return new Error(`section "${spec.name}" text must be a string`);
  return undefined;
}

/** 单层插值：未注册变量保持原样；变量函数抛错保持原样（降级不崩）；值不再递归展开 */
function interpolate(text: string, variables: Map<string, { readonly value: PromptVariable }>): string {
  return text.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (whole, name: string) => {
    const registered = variables.get(name);
    if (registered === undefined) return whole;
    const value = registered.value;
    if (typeof value === "string") return value;
    try {
      return value();
    } catch {
      return whole; // 坏变量降级：保持 {{name}} 占位，其余段照常
    }
  });
}
