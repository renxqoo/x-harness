import type { Disposer, Plugin } from "@x-harness/core";
import { sessionDisposed } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { toolsPreExecute } from "@x-harness/tools";
import type { PreExecuteDecision, ToolKind } from "@x-harness/tools";
import { decideFor, execOf } from "./decide.ts";
import type { BaselinePolicy } from "./baseline.ts";
import { createModeRegistry, modeRegistry, profileDecideOf, resolveProfileOf } from "./modes.ts";
import type { ModeFaces } from "./modes.ts";
import { summaryOf } from "./ask-summary.ts";
import { suggestedRuleOf } from "./bash/adjudicate.ts";
import type { Decision, DecideInput } from "./decide.ts";
import { GrantsRegistry } from "./grants.ts";
import { parseRules } from "./rules/parse.ts";
import type { ExecDirective, Verdict, PermissionProfile, RuleEntry } from "./types.ts";
import { permissionBroker, permissionDecided, permissionGrantStore, permissionGrantWritten, permissionGrants, permissionMode, fenceFacts } from "./tokens.ts";
import { memoryBlocked } from "./baseline.ts";
import { permissionAdjudicate } from "./tokens.ts";
import type { AskPayload, AskReply, PermissionRule } from "./types.ts";

export interface PermissionOptions {
  readonly root: string;
  readonly mode?: string;
  readonly customProfiles?: readonly PermissionProfile[];
  readonly rules?: readonly PermissionRule[];
  readonly projectRules?: readonly PermissionRule[];
  readonly protectedPaths?: readonly string[];
  readonly baseline?: BaselinePolicy;
}

function parseMemoryRule(raw: string | undefined, scope: "session" | "project" | "user"): RuleEntry | undefined {
  if (raw === undefined || raw.includes(";") || raw.includes("\n")) return undefined;
  let parsed: ReturnType<typeof parseRules>;
  try {
    parsed = parseRules([raw], scope);
  } catch {
    return undefined;
  }
  const first = parsed[0];
  if (first === undefined || first.verdict !== "allow" || memoryBlocked(first.pattern)) return undefined;
  return { tool: first.tool, pattern: first.pattern, verdict: "allow", nature: "grant", at: Date.now() };
}

function gateWithExec(downstream: PreExecuteDecision, exec: ExecDirective | undefined, faces: ModeFaces | undefined): PreExecuteDecision {
  if (downstream.kind !== "allow" || exec === undefined) return downstream;
  const escalatable = exec === "contained" && faces?.escalatable === true;
  return { ...downstream, exec, ...(escalatable ? { escalatable: true } : {}) };
}

function narrowKind(kind: string | undefined): ToolKind | undefined {
  return kind === "Read" || kind === "Write" || kind === "Danger" ? kind : undefined;
}

function rulesOf(entries: readonly PermissionRule[] | undefined, origin: "user" | "project"): PermissionRule[] {
  return (entries ?? []).map((entry) => ({ ...entry, origin }));
}

const UNRESOLVED_PROFILE: PermissionProfile = { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" };

export function createPermissionPlugin(options: PermissionOptions): Plugin {
  return {
    name: "permission",
    inject: ["tools"],
    apply: (ctx): Disposer => {
      const protectPattern = (pattern: string): string => {
        if (pattern.includes("*")) return pattern;
        return pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
      };
      const protectedRules: PermissionRule[] = (options.protectedPaths ?? []).map((pattern) => ({
        tool: "Write" as const,
        pattern: protectPattern(pattern),
        verdict: "deny" as const,
        origin: "default" as const,
      }));
      const userRules = [...rulesOf(options.rules, "user"), ...protectedRules];
      const projectRules = rulesOf(options.projectRules, "project");
      const grants = new GrantsRegistry();
      const modes = createModeRegistry();
      let mode: string = options.mode ?? "auto";
      grants.setUnrestricted(modes.resolve(mode)?.unrestricted === true);
      let tearingDown = false;

      const warnedModes = new Set<string>();
      const profileOf = (id: string): PermissionProfile => {
        const resolved = ctx.tryUse(resolveProfileOf)?.(id, options.customProfiles);
        if (resolved !== undefined) return resolved;
        if (!warnedModes.has(id)) {
          warnedModes.add(id);
          process.stderr.write(`permission: mode "${id}" unresolvable (profile service absent or unknown id) — falling back to auto (U3 断代)\n`);
        }
        return UNRESOLVED_PROFILE;
      };


      const modeService = {
        get: (): string => mode,
        set(next: string): void {
          mode = next;
          grants.setUnrestricted(modes.resolve(next)?.unrestricted === true);
        },
      };


      const writeMemory = async (fields: { scope: "session" | "project" | "user"; entry: RuleEntry; session: SessionId | undefined; from: string }): Promise<void> => {
        const { scope, entry, session, from } = fields;
        if (scope === "session") {
          grants.addRule(session, { ...entry, origin: "session" });
        } else {
          const store = ctx.tryUse(permissionGrantStore);
          if (store === undefined) return;
          const written = await store.write(scope, entry);
          if (!written.ok) {
            grants.addRule(session, { ...entry, origin: "session" });
            ctx.emit(permissionGrantWritten, { scope: "session", rule: `${entry.tool}(${entry.pattern}):${entry.verdict}`, from: `${from} (degraded: ${written.reason})` });
            return;
          }
        }
        ctx.emit(permissionGrantWritten, { scope, rule: `${entry.tool}(${entry.pattern}):${entry.verdict}`, from });
      };

      const memoryOptionsOf = (decision: Decision): AskPayload["options"] => {
        if (decision.memorizable !== true) return ["once"];
        return ctx.tryUse(permissionGrantStore) !== undefined ? ["once", "session", "project", "user"] : ["once", "session"];
      };

      const settleMemory = async (fields: { reply: AskReply; payload: AskPayload; decision: Decision; session: SessionId | undefined; from: string }): Promise<void> => {
        const { reply, payload, decision, session, from } = fields;
        if (reply.verdict !== "allow" || decision.memorizable !== true) return;
        if (reply.memory !== "session" && reply.memory !== "project" && reply.memory !== "user") return;
        const entry = parseMemoryRule(reply.ruleOverride?.trim() ?? payload.suggestedRule, reply.memory);
        if (entry !== undefined) await writeMemory({ scope: reply.memory, entry, session, from });
      };

      const ask = async (fields: { tool: string; args: unknown; decision: Decision; session: SessionId | undefined; commandOf: () => string; kind?: string }): Promise<"allow" | "deny"> => {
        const { tool, args, decision, session, commandOf, kind } = fields;
        if (tearingDown) return "deny";
        const broker = ctx.tryUse(permissionBroker);
        if (broker === undefined) return "deny";
        const payload: AskPayload = buildAskPayload({ tool, args, decision, session, commandOf, kind, optionsOf: memoryOptionsOf });
        let reply: AskReply;
        try {
          reply = await broker.ask(payload);
        } catch {
          return "deny";
        }
        if (tearingDown) return "deny";
        if (reply.verdict === "allow" && reply.memory !== undefined && decision.grant?.kind === "extraRoot") grants.addExtraRoot(session, decision.grant.dir);
        await settleMemory({ reply, payload, decision, session, from: commandOf() });
        return reply.verdict;
      };

      const emitAudit = (fields: { tool: string; verdict: Verdict; resolvedBy: string; reason: string; exec?: ExecDirective; session?: SessionId }): void => {
        ctx.emit(permissionDecided, fields);
      };

      const facesOf = (): ModeFaces | undefined => {
        const plugin = modes.resolve(mode);
        const knob = ctx.tryUse(profileDecideOf)?.(profileOf(mode));
        if (plugin === undefined) return knob;
        return { decide: plugin.decide ?? knob?.decide, posture: plugin.posture ?? knob?.posture, ...(plugin.escalatable === true || knob?.escalatable === true ? { escalatable: true } : {}) };
      };
      const decideInputOf = (payload: { readonly name: string; readonly args: unknown; readonly session?: SessionId; readonly control?: true; readonly kind?: string; readonly readsSubtree?: true }, profile: PermissionProfile): DecideInput => ({
        tool: payload.name,
        args: payload.args,
        ...(narrowKind(payload.kind) !== undefined ? { kind: narrowKind(payload.kind) } : {}),
        ...(payload.readsSubtree === true ? { pathScope: true } : {}),
        session: payload.session,
        userRules,
        ...(projectRules.length > 0 ? { projectRules } : {}),
        sessionRules: grants.rulesOf(payload.session),
        profile,
        root: options.root,
        extraRoots: grants.extraRootsOf(payload.session),
        ...(grants.isUnrestricted(payload.session) ? { unrestricted: true } : {}),
        ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
        ...(ctx.tryUse(fenceFacts) !== undefined ? { fence: ctx.tryUse(fenceFacts)?.forSession(payload.session) } : {}),
        ...(options.protectedPaths !== undefined ? { protectedWrite: options.protectedPaths } : {}),
        ...(() => {
          const faces = facesOf();
          return {
            ...(faces?.decide !== undefined ? { modeDecide: faces.decide } : {}),
            ...(faces?.posture !== undefined ? { postureDecide: faces.posture } : {}),
          };
        })(),
      });

      const adjudicateDirect = (payload: { readonly name: string; readonly args: unknown; readonly session?: SessionId; readonly control?: true; readonly kind?: string }): Decision =>
        decideFor(decideInputOf(payload, profileOf(mode)));
      const offAdjudicate = ctx.provide(permissionAdjudicate, adjudicateDirect);

      const offDecide = ctx.on(toolsPreExecute, async (payload, next): Promise<PreExecuteDecision> => {
        if (payload.control === true) {
          emitAudit({ tool: payload.name, verdict: "allow", resolvedBy: "control", reason: "control tool", ...(payload.session !== undefined ? { session: payload.session } : {}) });
          return next(payload);
        }
        const profile = profileOf(mode);
        const decision = decideFor(decideInputOf(payload, profile));
        let finalVerdict = decision.verdict;
        let finalReason = decision.reason;
        if (decision.verdict === "ask") {
          const commandOf = (): string => {
            const args = (payload.args ?? {}) as { command?: unknown };
            return typeof args.command === "string" ? args.command : payload.name;
          };
          const answer = await ask({ tool: payload.name, args: payload.args, decision, session: payload.session, commandOf, kind: payload.kind });
          finalVerdict = answer === "allow" ? "allow" : "deny";
          finalReason = answer === "allow" ? `${decision.reason} (approved)` : decision.reason;
        }
        const exec = finalVerdict === "allow" ? execOf("allow", profile) : undefined;
        emitAudit({
          tool: payload.name,
          verdict: finalVerdict,
          resolvedBy: decision.resolvedBy,
          reason: finalReason,
          ...(exec !== undefined ? { exec } : {}),
          ...(payload.session !== undefined ? { session: payload.session } : {}),
        });
        const downstream = await next(payload);
        if (finalVerdict === "deny") return { kind: "deny", reason: `permission:${finalReason}` };
        return gateWithExec(downstream, exec, facesOf());
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }) => grants.evict(session));
      const offGrants = ctx.provide(permissionGrants, grants);
      const offMode = ctx.provide(permissionMode, modeService);
      const offModes = ctx.provide(modeRegistry, modes);
      return () => {
        tearingDown = true;
        grants.seal();
        offDecide();
        offAdjudicate();
        offDisposed();
        offGrants();
        offMode();
        offModes();
        let offGuard: (() => void) | undefined;
        try {
          offGuard = ctx.on(toolsPreExecute, async (_payload, next): Promise<PreExecuteDecision> => {
            const inner = await next(_payload);
            if (inner.kind === "allow") return { kind: "deny", reason: "permission: unloaded (guard)" };
            return inner;
          });
        } catch {
        }
        void offGuard;
      };
    },
  };
}

function buildAskPayload(fields: {
  tool: string;
  args: unknown;
  decision: Decision;
  session: SessionId | undefined;
  commandOf: () => string;
  kind?: string;
  optionsOf: (d: Decision) => AskPayload["options"];
}): AskPayload {
  const { tool, args, decision, session, commandOf, kind, optionsOf } = fields;
  const summary = summaryOf(args);
  return {
    tool,
    ...(summary !== undefined ? { summary } : {}),
    reason: decision.reason,
    options: optionsOf(decision),
    ...(decision.memorizable === true ? { suggestedRule: decision.suggestedRule ?? (kind === "Danger" ? suggestedRuleOf(commandOf()) : undefined) } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}
