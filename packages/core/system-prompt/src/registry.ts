// sections/variables 注册表（docs/SYSTEM-PROMPT.md §1；ELEVATION-DESIGN §2.1 W2C）：
// 根层锚点定位代数（after/before，注册期环检测）、同名覆盖（沿用旧注册序）+ 身份守卫注销、
// {{var}} 单层插值（函数抛错保持原样）、sha256 指纹、排序缓存；会话层 section（锚定子集：
// 会话段只锚根层段名——跨层环构造性不存在；位次派生根层当前序——根序不因会话注册漂移）。
// 缓存双向失效：根层变异 → 全部会话合并缓存失效；会话层变异 → 仅该会话失效（键=双版本）。

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

/** 会话层合并投影缓存条目：双版本键（根版本, 会话版本）——任一变异即失效 */
interface MergedCache {
  readonly rootVersion: number;
  readonly sessionVersion: number;
  readonly order: readonly { readonly name: string; readonly session: boolean }[];
}

export function createPromptRegistry(): SystemPromptService & { dropLayer(sessionId: string): void } {
  const sections = new Map<string, SectionEntry>();
  const variables = new Map<string, { readonly value: PromptVariable; readonly identity: object }>();
  const sessionLayers = new Map<string, Map<string, SectionEntry>>();
  let regCounter = 0;
  let rootVersion = 0;
  let orderCache: readonly string[] | undefined;
  const sessionVersions = new Map<string, number>();
  const mergedCaches = new Map<string, MergedCache>();

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

  /** 合并视图环检测（终审 C1 兜底）：锚链查询同时看根层与本会话层——缺席锚不建边 */
  function wouldCycleMerged(name: string, spec: SectionSpec, layer: Map<string, SectionEntry>): boolean {
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
      const entry = sections.get(current) ?? layer.get(current);
      const anchor = entry === undefined ? undefined : anchorOf(entry.spec);
      if (anchor !== undefined && (anchor === name || sections.has(anchor) || layer.has(anchor))) queue.push(anchor);
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

  /** 根层注册/注销/覆盖的统一失效面：根序缓存 + 全部会话合并缓存（双向失效） */
  function invalidateRoot(): void {
    orderCache = undefined;
    rootVersion += 1;
    mergedCaches.clear();
  }

  /** 会话层分桶：after/before 按根锚名分桶，无锚/缺席锚落尾（注册序）。
   *  注：layer 是 Map<name, entry>——层内同名后者胜由 Map 语义承担（键唯一，值最新） */
  function bucketLayer(layer: Map<string, SectionEntry> | undefined): {
    readonly after: Map<string, SectionEntry[]>;
    readonly before: Map<string, SectionEntry[]>;
    readonly tail: SectionEntry[];
  } {
    const after = new Map<string, SectionEntry[]>();
    const before = new Map<string, SectionEntry[]>();
    const tail: SectionEntry[] = [];
    if (layer === undefined) return { after, before, tail };
    for (const entry of [...layer.values()].sort((a, b) => a.regIndex - b.regIndex)) {
      const anchor = anchorOf(entry.spec);
      if (anchor === undefined || !sections.has(anchor)) {
        tail.push(entry); // 无锚/缺席锚（含锚被注销）→ 根段之后
        continue;
      }
      const buckets = entry.spec.after !== undefined ? after : before;
      const bucket = buckets.get(anchor) ?? [];
      bucket.push(entry);
      buckets.set(anchor, bucket);
    }
    return { after, before, tail };
  }

  /** 会话层合并投影：根序游走 + 会话段按锚插位（δ/2ⁿ 语义与根层代数同款，n 按会话层注册序）。
   *  无锚/缺席锚会话段排全部根段之后（按会话层注册序）；同名会话段顶替根段位（覆盖）。 */
  function mergedOrder(sessionId: string): readonly { readonly name: string; readonly session: boolean }[] {
    if (orderCache === undefined) orderCache = resolveOrder();
    const sessionVersion = sessionVersions.get(sessionId) ?? 0;
    const cached = mergedCaches.get(sessionId);
    if (cached !== undefined && cached.rootVersion === rootVersion && cached.sessionVersion === sessionVersion) return cached.order;

    const { after: afterBuckets, before: beforeBuckets, tail } = bucketLayer(sessionLayers.get(sessionId));
    // 桶内序：after 按 n 降序（后注册更贴近锚——与根层 δ/2ⁿ 一致）；before 按 n 升序
    const byRegDesc = (a: SectionEntry, b: SectionEntry): number => b.regIndex - a.regIndex;
    const byRegAsc = (a: SectionEntry, b: SectionEntry): number => a.regIndex - b.regIndex;
    // 跳过：与根段同名的会话段（经根槽顶替呈现——不双发）
    const rootSet = new Set(orderCache);

    const order: { readonly name: string; readonly session: boolean }[] = [];
    for (const name of orderCache) {
      for (const entry of (beforeBuckets.get(name) ?? []).sort(byRegAsc)) {
        if (!rootSet.has(entry.spec.name)) order.push({ name: entry.spec.name, session: true });
      }
      order.push({ name, session: false }); // 根段（被会话同名覆盖时文本取会话版——assemble 按名查层）
      for (const entry of (afterBuckets.get(name) ?? []).sort(byRegDesc)) {
        if (!rootSet.has(entry.spec.name)) order.push({ name: entry.spec.name, session: true });
      }
    }
    for (const entry of tail.sort(byRegAsc)) {
      if (!rootSet.has(entry.spec.name)) order.push({ name: entry.spec.name, session: true });
    }
    const computed: MergedCache = { rootVersion, sessionVersion, order };
    mergedCaches.set(sessionId, computed);
    return computed.order;
  }

  /** 层内注册公共面（根/会话共用参数门与身份守卫；会话层附加锚定子集门） */
  function registerIn(layer: Map<string, SectionEntry>, spec: SectionSpec, isSession: boolean): () => void {
    const invalid = sectionSpecError(spec);
    if (invalid !== undefined) throw invalid;
    if (isSession) {
      // 锚定子集：会话段锚名不得指向本会话层（只许根层段名或缺席 no-op）
      const anchor = anchorOf(spec);
      if (anchor !== undefined && !sections.has(anchor) && layer.has(anchor)) {
        throw new Error(`session section "${spec.name}" may only anchor a root section (got session section "${anchor}")`);
      }
      // 跨层环兜底（终审 C1）：沿「根层∪本会话层」合并视图查环——根段可锚缺席名（如 S1）
      // 由本层补上成环（C after S1 + S1 after C）；单层检测互不可见
      if (wouldCycleMerged(spec.name, spec, layer)) {
        const a = anchorOf(spec) as string;
        throw new Error(`section cycle: ${spec.name} -> ${a}`);
      }
    } else if (wouldCycle(spec.name, spec)) {
      const anchor = anchorOf(spec) as string;
      throw new Error(`section cycle: ${spec.name} -> ${anchor}`);
    }
    const identity = {};
    const previous = layer.get(spec.name);
    layer.set(spec.name, { spec, identity, regIndex: previous?.regIndex ?? regCounter++ });
    return () => {
      const current = layer.get(spec.name);
      if (current?.identity === identity) layer.delete(spec.name);
    };
  }

  return {
    section: (spec: SectionSpec) => {
      const off = registerIn(sections, spec, false);
      invalidateRoot(); // 注册/覆盖/注销统一走双失效面（根变异 → 全部会话合并缓存失效）
      return () => {
        off();
        invalidateRoot();
      };
    },

    scoped: (sessionId: string) => ({
      section: (spec: SectionSpec) => {
        const layer = sessionLayers.get(sessionId) ?? new Map<string, SectionEntry>();
        const off = registerIn(layer, spec, true); // throw 不留空层（终审 C2）
        sessionLayers.set(sessionId, layer);
        const bump = (): void => {
          sessionVersions.set(sessionId, (sessionVersions.get(sessionId) ?? 0) + 1); // 仅本会话合并缓存失效
        };
        bump();
        return () => {
          off();
          bump();
        };
      },
    }),

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

    assemble: (options) => {
      const sessionId = options?.sessionId;
      const layer = sessionId === undefined ? undefined : sessionLayers.get(sessionId);
      const order = sessionId === undefined
        ? (orderCache === undefined ? (orderCache = resolveOrder()) : orderCache).map((name) => ({ name, session: false }))
        : mergedOrder(sessionId);
      const joined = order
        .map(({ name }) => resolveText(name, (layer?.get(name) ?? sections.get(name))?.spec.text))
        .join("\n\n");
      const text = interpolate(joined, variables);
      return { text, fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 16) };
    },

    dropLayer: (sessionId: string): void => {
      sessionLayers.delete(sessionId); // 会话终结清层（挂账#4——plugin 挂 sessionDisposed，与 tools.dropRestriction 同款生命周期）
    },
  };
}

/** text 形状门（拆分自 sectionSpecError——复杂度预算） */
function textSpecError(spec: SectionSpec): Error | undefined {
  if (typeof spec.text !== "string" && typeof spec.text !== "function") {
    return new Error(`section "${spec.name}" text must be a string or function`);
  }
  return undefined;
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
  return textSpecError(spec);
}

/** 段文本解析：函数形 assemble 期现算；抛错 → 段级降级占位（不中断装配） */
function resolveText(name: string, text: string | (() => string) | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  try {
    return text();
  } catch (error) {
    return `[section ${name} render error: ${error instanceof Error ? error.message : String(error)}]`;
  }
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
