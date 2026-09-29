import type { AdjudicationFacts, Decision, ModePlugin, PermissionProfile } from "@x-harness/permission";
import { classifyPipeline } from "./classifier.ts";

const allow = (reason: string, resolvedBy: string): Decision => ({ verdict: "allow", reason, resolvedBy });
const ask = (reason: string, resolvedBy: string, extra: { memorizable?: true; suggestedRule?: string } = {}): Decision =>
  ({ verdict: "ask", reason, resolvedBy, ...(extra.memorizable === true ? { memorizable: true } : {}), ...(extra.suggestedRule !== undefined ? { suggestedRule: extra.suggestedRule } : {}) });
const deny = (reason: string, resolvedBy: string): Decision => ({ verdict: "deny", reason, resolvedBy });

const classOf = (facts: AdjudicationFacts): "readonly" | "write" | "unclassified" =>
  classifyPipeline(facts.segments ?? [], facts.hasOutputRedirect === true, facts.roots ?? []);

export const fullMode: ModePlugin = {
  id: "full",
  unrestricted: true,
  decide: (facts) => {
    if (facts.elevation === true) return deny("hard-deny:sudo", "mode:full");
    if (facts.kind === "Danger") return allow("full mode", "mode:full");
    return allow("full mode", "mode:full");
  },
};

export const autoMode: ModePlugin = {
  id: "auto",
  posture: (facts) => {
    if (facts.face === "path") {
      if (facts.pathAbsent === true) return ask(`path-absent:${facts.tool}`, "path-absent");
      if (facts.inRoot === true) return allow("in-root", "auto");
      if (facts.path === undefined || facts.kind === undefined) return undefined;
      const dir = facts.path.slice(0, Math.max(facts.path.lastIndexOf("/"), 1));
      const rootGrantable = dir !== "/" && facts.kind === "Write";
      const hasGlobMeta = (s: string): boolean => s.includes("*") || s.includes("?") || s.includes("[");
      const literalPath = facts.path.replace(/\*/g, "[*]").replace(/\?/g, "[?]").replace(/\[/g, "[[]");
      const suggested = dir === "/" || hasGlobMeta(dir)
        ? `${facts.kind}(${literalPath}):allow`
        : `${facts.kind}(${dir}/**):allow`;
      return {
        verdict: "ask" as const,
        reason: `outside-root:${facts.path}`,
        resolvedBy: "outside-root",
        ...(rootGrantable ? { grant: { kind: "extraRoot" as const, dir } } : {}),
        memorizable: true as const,
        suggestedRule: suggested,
      };
    }
    if (facts.face !== "bash") return undefined;
    if ((facts.segments ?? []).some((cmd) => cmd.opaque !== undefined)) return undefined;
    const cls = classOf(facts);
    if (cls === "readonly") return allow("classifier:readonly", "classifier:readonly");
    if (cls === "write") return allow("classifier:in-root-write", "classifier:in-root-write");
    return undefined;
  },
};

export const editConfirmMode: ModePlugin = {
  id: "edit-confirm",
  posture: (facts) => {
    if (facts.face === "path") {
      if (facts.pathAbsent === true) return ask(`path-absent:${facts.tool}`, "path-absent");
      if (facts.inRoot === true && facts.kind === "Write") {
        return ask("edit-confirm: in-root write", "edit-confirm", { memorizable: true, suggestedRule: `Write(${(facts.root ?? "/").replace(/\/+$/, "")}/**):allow` });
      }
    }
    if (facts.kind === "Danger" && classOf(facts) === "write") {
      return ask("edit-confirm: in-root write", "edit-confirm", { memorizable: true });
    }
    return autoMode.posture?.(facts);
  },
};

export const sandboxedAutoMode: ModePlugin = {
  id: "sandboxed-auto",
  escalatable: true,
  posture: (facts) => {
    if (facts.kind === "Danger" && (classOf(facts) === "unclassified" || (facts.segments ?? []).some((cmd) => cmd.opaque !== undefined))) {
      return allow("classifier:unclassified (fenced)", "classifier:unclassified");
    }
    return autoMode.posture?.(facts);
  },
};

export const planDefaultMode: ModePlugin = {
  id: "plan",
  decide: (facts) => {
    if (facts.face === "path" && facts.kind === "Write") return deny("plan mode disallows write", "mode:plan");
    if (facts.kind === "Danger") {
      if (facts.parseFailed !== undefined) return deny("plan mode: command not parseable", "mode:plan");
      if (facts.elevation === true || facts.hardDenyKind !== undefined) return deny("plan mode: elevation denied", "mode:plan");
      return deny("plan mode disallows bash", "mode:plan");
    }
    return undefined;
  },
  posture: autoMode.posture,
};

export interface KnobDecide {
  readonly decide?: (facts: AdjudicationFacts) => Decision | undefined;
  readonly posture?: (facts: AdjudicationFacts) => Decision | undefined;
}

export function knobDecideOf(profile: { readonly askPolicy: string; readonly containment: string; readonly mutationPolicy?: string }): KnobDecide {
  if (profile.mutationPolicy === "plan-deny") return planDefaultMode;
  if (profile.mutationPolicy === "confirm-all") return editConfirmMode;
  if (profile.askPolicy === "always") return editConfirmMode;
  if (profile.askPolicy === "never" && profile.containment === "none") return fullMode;
  if (profile.askPolicy === "on-failure" && profile.containment === "fenced") return sandboxedAutoMode;
  return autoMode;
}


export function resolveProfile(id: string, customRows?: readonly PermissionProfile[]): PermissionProfile | undefined {
  const builtin = BUILTIN_PROFILES.find((p) => p.id === id);
  if (builtin !== undefined) return builtin;
  if (customRows !== undefined) {
    const custom = customRows.find((p) => p.id === id);
    if (custom !== undefined) return custom;
  }
  return undefined;
}

export const BUILTIN_PROFILES: readonly PermissionProfile[] = [
  { id: "plan", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" },
  { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "edit-confirm", askPolicy: "on-opaque", containment: "none", mutationPolicy: "confirm-all" },
  { id: "full", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "sandboxed-auto", askPolicy: "on-failure", containment: "fenced", mutationPolicy: "auto-in-root" },
];
