import { createHash } from "node:crypto";
import type { PromptVariable, SectionSpec, SystemPromptService } from "./types.ts";

const TAIL_BASE = 1_000_000;
const DELTA = 0.5;

interface SectionEntry {
  readonly spec: SectionSpec;
  readonly identity: object;
  readonly regIndex: number;
}

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
    const memo = new Map<string, number>();
    const anchorChildren = new Map<string, number>();
    const orderOf = (name: string): number => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const entry = sections.get(name);
      if (entry === undefined) return TAIL_BASE;
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
    for (const name of [...sections.keys()].sort((a, b) => regIndexOf(a) - regIndexOf(b))) orderOf(name);
    return [...sections.keys()].sort((a, b) => orderOf(a) - orderOf(b) || regIndexOf(a) - regIndexOf(b));
  }

  function regIndexOf(name: string): number {
    return sections.get(name)?.regIndex ?? 0;
  }

  function invalidateRoot(): void {
    orderCache = undefined;
    rootVersion += 1;
    mergedCaches.clear();
  }

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
        tail.push(entry);
        continue;
      }
      const buckets = entry.spec.after !== undefined ? after : before;
      const bucket = buckets.get(anchor) ?? [];
      bucket.push(entry);
      buckets.set(anchor, bucket);
    }
    return { after, before, tail };
  }

  function mergedOrder(sessionId: string): readonly { readonly name: string; readonly session: boolean }[] {
    if (orderCache === undefined) orderCache = resolveOrder();
    const sessionVersion = sessionVersions.get(sessionId) ?? 0;
    const cached = mergedCaches.get(sessionId);
    if (cached !== undefined && cached.rootVersion === rootVersion && cached.sessionVersion === sessionVersion) return cached.order;

    const { after: afterBuckets, before: beforeBuckets, tail } = bucketLayer(sessionLayers.get(sessionId));
    const byRegDesc = (a: SectionEntry, b: SectionEntry): number => b.regIndex - a.regIndex;
    const byRegAsc = (a: SectionEntry, b: SectionEntry): number => a.regIndex - b.regIndex;
    const rootSet = new Set(orderCache);

    const order: { readonly name: string; readonly session: boolean }[] = [];
    for (const name of orderCache) {
      for (const entry of (beforeBuckets.get(name) ?? []).sort(byRegAsc)) {
        if (!rootSet.has(entry.spec.name)) order.push({ name: entry.spec.name, session: true });
      }
      order.push({ name, session: false });
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

  function registerIn(layer: Map<string, SectionEntry>, spec: SectionSpec, isSession: boolean): () => void {
    const invalid = sectionSpecError(spec);
    if (invalid !== undefined) throw invalid;
    if (isSession) {
      const anchor = anchorOf(spec);
      if (anchor !== undefined && !sections.has(anchor) && layer.has(anchor)) {
        throw new Error(`session section "${spec.name}" may only anchor a root section (got session section "${anchor}")`);
      }
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
      invalidateRoot();
      return () => {
        off();
        invalidateRoot();
      };
    },

    scoped: (sessionId: string) => ({
      section: (spec: SectionSpec) => {
        const layer = sessionLayers.get(sessionId) ?? new Map<string, SectionEntry>();
        const off = registerIn(layer, spec, true);
        sessionLayers.set(sessionId, layer);
        const bump = (): void => {
          sessionVersions.set(sessionId, (sessionVersions.get(sessionId) ?? 0) + 1);
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
      sessionLayers.delete(sessionId);
      mergedCaches.delete(sessionId);
      sessionVersions.delete(sessionId);
    },
  };
}

function textSpecError(spec: SectionSpec): Error | undefined {
  if (typeof spec.text !== "string" && typeof spec.text !== "function") {
    return new Error(`section "${spec.name}" text must be a string or function`);
  }
  return undefined;
}

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

function resolveText(name: string, text: string | (() => string) | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  try {
    return text();
  } catch (error) {
    return `[section ${name} render error: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function interpolate(text: string, variables: Map<string, { readonly value: PromptVariable }>): string {
  return text.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (whole, name: string) => {
    const registered = variables.get(name);
    if (registered === undefined) return whole;
    const value = registered.value;
    if (typeof value === "string") return value;
    try {
      return value();
    } catch {
      return whole;
    }
  });
}
