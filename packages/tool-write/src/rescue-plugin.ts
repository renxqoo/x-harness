import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";
import { admitSession } from "@x-harness/tool-core";
import type { ExtraRootsOf, ObservedRegistry, PathGate, RootOverrideOf } from "@x-harness/tool-core";
import type { ExecEnv } from "@x-harness/exec-env";
import { decideFor, fenceFacts, permissionAdjudicate, permissionGrants, permissionMode } from "@x-harness/permission";
import { knobDecideOf, resolveProfile } from "@x-harness/permission-modes";
import type { PermissionRule } from "@x-harness/permission";
import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { extractStringField } from "./extract-string-field.ts";

function decideForKnob(input: Parameters<typeof decideFor>[0]): ReturnType<typeof decideFor> {
  const faces = knobDecideOf(input.profile);
  return decideFor({
    ...input,
    kind: "Write",
    ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}),
    ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}),
  });
}

import { extractLastEditText } from "./extract-last-edit-text.ts";

const MIN_RESCUE_CHARS = 512;

export interface TruncatedRescueInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly permission?: {
    readonly root: string;
    readonly rules?: readonly PermissionRule[];
    readonly projectRules?: readonly PermissionRule[];
    readonly protectedWrite?: readonly string[];
  };
}

export function createTruncatedWriteRescuePlugin(input: TruncatedRescueInput): Plugin {
  const { gate, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  const perm = input.permission;
  return {
    name: "tool-write-truncated-rescue",
    apply: (ctx: Context): Disposer => {
      const grants = ctx.tryUse(permissionGrants);
      const mode = ctx.tryUse(permissionMode);
      const fence = ctx.tryUse(fenceFacts);
      const adjudicate = ctx.tryUse(permissionAdjudicate);

      const rescuePermissionOf = (session: TruncatedToolPayload["session"], absolute: string): "allow" | "rescue-denied" | undefined => {
        if (adjudicate !== undefined && perm !== undefined) {
          const decision = adjudicate({ name: "write", kind: "Write", args: { path: relPathWithin(absolute, perm.root, realpathSync) }, session });
          return decision.verdict === "allow" ? "allow" : "rescue-denied";
        }
        if (perm === undefined || grants === undefined || mode === undefined) return undefined;
        const decision = decideForKnob({
          tool: "write",
          args: { path: relPathWithin(absolute, perm.root, realpathSync) },
          session,
          userRules: perm.rules ?? [],
          ...(perm.projectRules !== undefined && perm.projectRules.length > 0 ? { projectRules: perm.projectRules } : {}),
          sessionRules: grants.rulesOf(session),
          profile: resolveProfile(mode.get()) ?? { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" },
          root: perm.root,
          extraRoots: grants.extraRootsOf(session),
          ...(fence !== undefined ? { fence: fence.forSession(session) } : {}),
          ...(perm.protectedWrite !== undefined ? { protectedWrite: perm.protectedWrite } : {}),
        });
        return decision.verdict === "allow" ? "allow" : "rescue-denied";
      };
      return ctx.on(
        agentTruncatedTool,
        async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>) => {
          const downstream = await next(payload);
          if (payload.signal.aborted) return downstream;
          if (downstream !== undefined) return downstream;
          const kind = toolKindOf(payload.name);
          if (kind === undefined) return downstream;
          const { path, value } = kind.edit === true ? extractLastEditText(payload.arguments) : extractStringField(payload.arguments, kind.field);
          if (path === undefined || path === "" || value === undefined) return downstream;
          if (value.length < MIN_RESCUE_CHARS) {
            return { note: `truncated arguments too short to be worth a draft (${String(value.length)} chars)` };
          }
          const admitted = await admitSession({ gate, realpath: env.realpath, session: payload.session, extraRootsOf, rootOverrideOf, target: `${path}.partial` });
          if (!admitted.ok) return { note: "target outside workspace boundary, draft not saved" };
          const decision = rescuePermissionOf(payload.session, admitted.path);
          if (decision === "rescue-denied") return { note: "target not permitted for rescue write, draft not saved" };
          if (decision === undefined) return downstream;
          const st = await env.stat(admitted.path);
          if (st.ok) return { note: `draft exists at ${path}.partial, not overwritten` };
          const written = await env.writeFileAtomic(admitted.path, Buffer.from(value, "utf8"), { makeParents: true });
          if (!written.ok) return downstream;
          return { note: kind.note({ chars: value.length, lines: value.split("\n").length, path }) };
        },
      );
    },
  } satisfies Plugin;
}

function relPathWithin(absolute: string, root: string, realpathOf: (p: string) => string): string {
  const rel = relative(realpathOf(root), absolute);
  return rel.startsWith("..") ? absolute : rel;
}

interface RescueKind {
  readonly field: string;
  readonly edit?: true;
  readonly note: (f: { readonly chars: number; readonly lines: number; readonly path: string }) => string;
}

function toolKindOf(name: string): RescueKind | undefined {
  const lower = name.toLowerCase();
  if (lower === "write") {
    return {
      field: "content",
      note: (f) => `Recovered ${String(f.chars)} chars (${String(f.lines)} lines) of the truncated write to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.`,
    };
  }
  if (lower === "edit") {
    return {
      field: "newText",
      edit: true,
      note: (f) => `Recovered ${String(f.chars)} chars of the last edit's newText in the truncated edit call to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, re-issue the edits in smaller, separate edit calls, then delete the .partial.`,
    };
  }
  return undefined;
}
