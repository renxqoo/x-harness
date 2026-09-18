// toolbox 工厂（docs/TOOLBOX.md §0 + docs/EXEC-ENV.md §0/§3）：四插件共享路径门与观察登记
// （read+write 成对装配）；env 三级解析（工厂参数 > execEnv 服务 > 装配期 throw——fail-closed）；
// 会话授权根（permissionGrants.extraRootsOf）注入工具；sessionDisposed 逐出观察桶。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { execEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { resolve } from "node:path";
import { PathGate } from "./paths.ts";
import { ObservedRegistry } from "./observed.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { createGrepTool } from "./grep.ts";

export interface ToolboxOptions {
  readonly root?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly spillDir?: string;
  readonly rgPath?: string;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
}

export type ExtraRootsOf = (session: string | undefined) => readonly string[];

interface EnvRegisteringInput {
  readonly make: (env: ExecEnv, extraRootsOf: ExtraRootsOf) => ToolDefinition;
  readonly name: string;
  readonly envOption: ExecEnv | undefined;
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
}

function envRegistering(input: EnvRegisteringInput): Plugin {
  const { make, name, envOption, gate, observed } = input;
  return {
    name,
    inject: ["tools"],
    apply: (ctx: Context): Disposer => {
      const env = envOption ?? ctx.tryUse(execEnv);
      if (env === undefined) throw new Error(`toolbox: ${name} requires an ExecEnv (pass options.env or provide the exec-env service)`);
      // gate/env 根一致性 fail-closed：错配=执法面漂移（fs 执法在 gate、围栏在 env.root——审查 F9）
      if (resolve(env.root) !== resolve(gate.lexicalRoot) && resolve(env.root) !== resolve(gate.root)) {
        throw new Error(`toolbox: ${name} env.root (${env.root}) does not match gate root (${gate.root}) — refusing ambiguous confinement`);
      }
      const grants = ctx.tryUse(permissionGrants); // 会话授权根（permission 缺席=无扩展）
      const extraRootsOf: ExtraRootsOf = (session) => grants?.extraRootsOf(session as never) ?? [];
      const offRegister = ctx.use(toolRegistry).register(make(env, extraRootsOf));
      const offEvict = ctx.on(sessionDisposed, ({ session }) => observed.evict(session));
      return () => {
        offEvict();
        offRegister();
      };
    },
  };
}

export function createToolbox(options: ToolboxOptions = {}) {
  const gate = new PathGate(options.root ?? process.cwd());
  const observed = new ObservedRegistry();
  const limits: BashLimits = defaultLimits(options);
  const register = (make: (env: ExecEnv, extraRootsOf: ExtraRootsOf) => ToolDefinition, name: string): Plugin =>
    envRegistering({ make, name, envOption: options.env, gate, observed });
  return {
    readPlugin: register((env, extraRootsOf) => createReadTool({ gate, observed, env, extraRootsOf }), "tool-read"),
    writePlugin: register((env, extraRootsOf) => createWriteTool({ gate, observed, env, extraRootsOf }), "tool-write"),
    bashPlugin: register((env) => createBashTool({ gate, limits, env }), "tool-bash"),
    grepPlugin: register((env, extraRootsOf) => createGrepTool({ gate, options: { rgPath: options.rgPath }, env, extraRootsOf }), "tool-grep"),
    /** 测试/宿主直取句柄 */
    gate,
    observed,
    limits,
  };
}
