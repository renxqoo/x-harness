import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { execEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { systemPrompt, wellKnown } from "@x-harness/system-prompt";
import { resolve } from "node:path";
import type { PathGate, RootOverrideOf } from "./paths.ts";
import type { ObservedRegistry } from "./observed.ts";

export type ExtraRootsOf = (session: string | undefined) => readonly string[];

export interface ToolPluginInput {
  readonly make: (env: ExecEnv, extraRootsOf: ExtraRootsOf, rootOverrideOf: RootOverrideOf) => ToolDefinition;
  readonly name: string;
  readonly envOption?: ExecEnv;
  readonly gate: PathGate;
  readonly systemRoots?: readonly string[];
  readonly observed?: ObservedRegistry;
  readonly attach?: (ctx: Context) => Disposer | void;
  readonly guidance?: string | ((env: ExecEnv) => string);
}

function dockGuidance(ctx: Context, toolName: string, text: string | undefined): Disposer | undefined {
  if (text === undefined || text === "") return undefined;
  const svc = ctx.tryUse(systemPrompt);
  if (svc === undefined) return undefined;
  return svc.section({ name: `tool/${toolName}`, after: wellKnown.baseCore, text });
}

export function createToolPlugin(input: ToolPluginInput): Plugin {
  const { make, name, envOption, gate, systemRoots, observed, attach, guidance } = input;
  return {
    name,
    inject: ["tools"],
    softInject: ["system-prompt", "sandbox", "permission"],
    apply: (ctx: Context): Disposer => {
      const env = envOption ?? ctx.tryUse(execEnv);
      if (env === undefined) throw new Error(`${name} requires an ExecEnv (pass env to the factory or provide the exec-env service)`);
      if (resolve(env.root) !== resolve(gate.lexicalRoot) && resolve(env.root) !== resolve(gate.root)) {
        throw new Error(`${name} env.root (${env.root}) does not match gate root (${gate.root}) — refusing ambiguous confinement`);
      }
      const grants = ctx.tryUse(permissionGrants);
      const staticRoots = systemRoots ?? [];
      const extraRootsOf: ExtraRootsOf = (session) => [...staticRoots, ...(grants?.extraRootsOf(session as never) ?? [])];
      const rootOverrideOf: RootOverrideOf = (session) => grants?.rootOverrideOf(session as never);
      const made = make(env, extraRootsOf, rootOverrideOf);
      let text: string | undefined;
      if (typeof guidance === "string") text = guidance;
      else if (guidance !== undefined) text = guidance(env);
      const def = text === undefined || text === "" ? made : { ...made, guidance: text };
      const offRegister = ctx.use(toolRegistry).register(def);
      const offDock = dockGuidance(ctx, def.name, text);
      const offEvict = observed === undefined ? undefined : ctx.on(sessionDisposed, ({ session }) => observed.evict(session));
      const offAttach = attach?.(ctx);
      return () => {
        offAttach?.();
        offEvict?.();
        offDock?.();
        offRegister();
      };
    },
  };
}
