// 工具插件工厂（docs/TOOLBOX.md §0）：四命令包共用的装配面——env 三级解析
// （工厂参数 > execEnv 服务 > 装配期 throw——fail-closed）、gate/env 根一致性 fail-closed
// （错配=执法面漂移：fs 执法在 gate、围栏在 env.root——审查 F9）、会话授权根
// （permissionGrants.extraRootsOf/rootOverrideOf）注入工具、sessionDisposed 逐出观察桶
// （仅传 observed 的 read/write 挂——桶只由它们产生）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { execEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { resolve } from "node:path";
import type { PathGate, RootOverrideOf } from "./paths.ts";
import type { ObservedRegistry } from "./observed.ts";

export type ExtraRootsOf = (session: string | undefined) => readonly string[];

export interface ToolPluginInput {
  readonly make: (env: ExecEnv, extraRootsOf: ExtraRootsOf, rootOverrideOf: RootOverrideOf) => ToolDefinition;
  readonly name: string;
  readonly envOption?: ExecEnv;
  readonly gate: PathGate;
  /** 观察登记（read/write 穿引同一实例）：在场挂 sessionDisposed 逐出；bash/grep 不传 */
  readonly observed?: ObservedRegistry;
  /** 装配期附加生命周期（env 解析后调用；返回的 Disposer 随插件拆卸执行） */
  readonly attach?: (ctx: Context) => Disposer | void;
}

export function createToolPlugin(input: ToolPluginInput): Plugin {
  const { make, name, envOption, gate, observed, attach } = input;
  return {
    name,
    inject: ["tools"],
    apply: (ctx: Context): Disposer => {
      const env = envOption ?? ctx.tryUse(execEnv);
      if (env === undefined) throw new Error(`${name} requires an ExecEnv (pass env to the factory or provide the exec-env service)`);
      // gate/env 根一致性 fail-closed：错配=执法面漂移（fs 执法在 gate、围栏在 env.root——审查 F9）
      if (resolve(env.root) !== resolve(gate.lexicalRoot) && resolve(env.root) !== resolve(gate.root)) {
        throw new Error(`${name} env.root (${env.root}) does not match gate root (${gate.root}) — refusing ambiguous confinement`);
      }
      const grants = ctx.tryUse(permissionGrants); // 会话授权根（permission 缺席=无扩展）
      const extraRootsOf: ExtraRootsOf = (session) => grants?.extraRootsOf(session as never) ?? [];
      const rootOverrideOf: RootOverrideOf = (session) => grants?.rootOverrideOf(session as never);
      const offRegister = ctx.use(toolRegistry).register(make(env, extraRootsOf, rootOverrideOf));
      const offEvict = observed === undefined ? undefined : ctx.on(sessionDisposed, ({ session }) => observed.evict(session));
      const offAttach = attach?.(ctx);
      return () => {
        offAttach?.();
        offEvict?.();
        offRegister();
      };
    },
  };
}
