// 工具插件工厂（docs/TOOLBOX.md §0）：四命令包共用的装配面——env 三级解析
// （工厂参数 > execEnv 服务 > 装配期 throw——fail-closed）、gate/env 根一致性 fail-closed
// （错配=执法面漂移：fs 执法在 gate、围栏在 env.root——审查 F9）、读根注入工具
// （systemRoots 装配期系统固有读根 + permissionGrants.extraRootsOf/rootOverrideOf
// 用户授权根）、sessionDisposed 逐出观察桶（仅传 observed 的 read/write 挂——桶只由它们产生）。

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
  /** 系统固有读根（装配期静态——与 permission 的用户授权根语义分立）：任务日志子树等
   *  系统产物目录的读面放行（docs/TASK-PUSH-DESIGN.md §2.3）；授权/撤销 UI 面零污染 */
  readonly systemRoots?: readonly string[];
  /** 观察登记（read/write 穿引同一实例）：在场挂 sessionDisposed 逐出；bash/grep 不传 */
  readonly observed?: ObservedRegistry;
  /** 装配期附加生命周期（env 解析后调用；返回的 Disposer 随插件拆卸执行） */
  readonly attach?: (ctx: Context) => Disposer | void;
  /** 使用守则（投稿式，DESIGN §1 D3）：函数形接收解析后的 env——配置感知（bash 按 sandbox
   *  与否分支）。非空文本直接停靠为 section tool/<name>（锚 wellKnown.baseCore——内核投稿
   *  纪律：锚点名内核所有）。**装配序硬约束（D6）**：带 guidance 的 tool-* 必须排在
   *  system-prompt 之后（tryUse 即时求值，晚序=段静默缺失；sandbox/execEnv 同款先例）；
   *  无 prompt 服务的世界优雅降级不注册 */
  readonly guidance?: string | ((env: ExecEnv) => string);
}

/** guidance 投稿停靠（DESIGN §1 D3/D6）：system-prompt 服务在场且文本非空 → 注册
 *  section tool/<name>（锚 wellKnown.baseCore）；缺席/空文本 → 不注册（优雅降级/零守则） */
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
    // S0 软依赖（F-01 处置——五处 apply 期停靠的三处在 tool-core）：system-prompt（guidance
    // 停靠）/sandbox（execEnv 停靠）/permission（grants apply 期闭包捕获）——
    // 在场则排后，缺席无约束（env 缺席仍 fail-closed throw）
    softInject: ["system-prompt", "sandbox", "permission"],
    apply: (ctx: Context): Disposer => {
      const env = envOption ?? ctx.tryUse(execEnv);
      if (env === undefined) throw new Error(`${name} requires an ExecEnv (pass env to the factory or provide the exec-env service)`);
      // gate/env 根一致性 fail-closed：错配=执法面漂移（fs 执法在 gate、围栏在 env.root——审查 F9）
      if (resolve(env.root) !== resolve(gate.lexicalRoot) && resolve(env.root) !== resolve(gate.root)) {
        throw new Error(`${name} env.root (${env.root}) does not match gate root (${gate.root}) — refusing ambiguous confinement`);
      }
      const grants = ctx.tryUse(permissionGrants); // 会话授权根（permission 缺席=无扩展）
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
