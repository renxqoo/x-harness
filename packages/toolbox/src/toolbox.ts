// toolbox 工厂（docs/TOOLBOX.md §0 + docs/EXEC-ENV.md §0/§3）：四插件共享路径门与观察登记
// （read+write 成对装配）；env 三级解析（工厂参数 > execEnv 服务 > 装配期 throw——fail-closed）；
// 会话授权根（permissionGrants.extraRootsOf）注入工具；sessionDisposed 逐出观察桶并两段杀后台任务；
// BackgroundTasks 登记簿（tasks.ts）——未来通用任务动词（task_output/task_stop）的 bash 源。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { execEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { resolve } from "node:path";
import { PathGate } from "./paths.ts";
import type { RootOverrideOf } from "./paths.ts";
import { ObservedRegistry } from "./observed.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createBashTool, defaultLimits } from "./bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";
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
  /** 每会话后台任务并发帽（缺省 3） */
  readonly maxConcurrentTasks?: number;
  /** 后台任务墙钟帽 ms（缺省 600_000——任务生命周期上限，与前台 turn 等待上限解耦） */
  readonly taskTimeoutMs?: number;
}

export type ExtraRootsOf = (session: string | undefined) => readonly string[];

interface EnvRegisteringInput {
  readonly make: (env: ExecEnv, extraRootsOf: ExtraRootsOf, rootOverrideOf: RootOverrideOf) => ToolDefinition;
  readonly name: string;
  readonly envOption: ExecEnv | undefined;
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  /** 装配期附加生命周期（env 解析后调用；返回的 Disposer 随插件拆卸执行） */
  readonly attach?: (ctx: Context) => Disposer | void;
}

function envRegistering(input: EnvRegisteringInput): Plugin {
  const { make, name, envOption, gate, observed, attach } = input;
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
      const rootOverrideOf: RootOverrideOf = (session) => grants?.rootOverrideOf(session as never);
      const offRegister = ctx.use(toolRegistry).register(make(env, extraRootsOf, rootOverrideOf));
      const offEvict = ctx.on(sessionDisposed, ({ session }) => observed.evict(session));
      const offAttach = attach?.(ctx);
      return () => {
        offAttach?.();
        offEvict();
        offRegister();
      };
    },
  };
}

export function createToolbox(options: ToolboxOptions = {}) {
  const gate = new PathGate(options.root ?? process.cwd());
  const observed = new ObservedRegistry();
  const limits = defaultLimits(options);
  const tasks = new BackgroundTasks(defaultTaskLimits(options, limits));
  const register = (make: (env: ExecEnv, extraRootsOf: ExtraRootsOf, rootOverrideOf: RootOverrideOf) => ToolDefinition, name: string, attach?: EnvRegisteringInput["attach"]): Plugin =>
    envRegistering({ make, name, envOption: options.env, gate, observed, attach });
  return {
    readPlugin: register((env, extraRootsOf, rootOverrideOf) => createReadTool({ gate, observed, env, extraRootsOf, rootOverrideOf }), "tool-read"),
    writePlugin: register((env, extraRootsOf, rootOverrideOf) => createWriteTool({ gate, observed, env, extraRootsOf, rootOverrideOf }), "tool-write"),
    bashPlugin: register(
      (env, _extraRootsOf, rootOverrideOf) => createBashTool({ gate, limits, env, tasks, rootOverrideOf }),
      "tool-bash",
      // 会话终结：该会话后台任务两段杀并清桶（登记生命周期=会话生命周期）；装配拆卸：全部直接 KILL
      (ctx) => {
        const off = ctx.on(sessionDisposed, ({ session }) => tasks.evict(session));
        return () => {
          off();
          tasks.stopAll();
        };
      },
    ),
    grepPlugin: register((env, extraRootsOf, rootOverrideOf) => createGrepTool({ gate, options: { rgPath: options.rgPath }, env, extraRootsOf, rootOverrideOf }), "tool-grep"),
    /** 测试/宿主直取句柄（tasks=后台任务登记簿——未来通用任务动词的 bash 源） */
    gate,
    observed,
    limits,
    tasks,
  };
}
