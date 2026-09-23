// bash 插件装配（docs/TOOLBOX.md §0/§4）：createToolPlugin 包 createBashTool；limits/taskLimits
// 收部分配置（缺省 defaultLimits/defaultTaskLimits 补齐）。生效登记簿（外穿实例或自建）
// provide 为 backgroundTasks 服务——task-tools 停靠共享（可选依赖，装配序无关）。
// 生命周期：会话终结 → 该会话后台任务两段杀并清桶；装配拆卸 → 全部直接 KILL。

import { createHash } from "node:crypto";
import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { permissionBroker, permissionGrantStore, permissionGrants } from "@x-harness/permission";
import { parseRules } from "@x-harness/permission";
import { sessionDisposed } from "@x-harness/session";
import { createToolPlugin } from "@x-harness/tool-core";
import { PathGate } from "@x-harness/tool-core";
import { createBashTool, defaultLimits } from "./bash.ts";
import type { BashLimits } from "./bash.ts";
import { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";
import { backgroundTasks } from "./tokens.ts";

/** 前台执行限额（部分字段——缺省补齐；defaultTimeoutMs > maxTimeoutMs 装配期 throw） */
export type BashLimitsOptions = Partial<Pick<BashLimits, "defaultTimeoutMs" | "maxTimeoutMs" | "maxOutputBytes" | "spillDir">>;

/** 后台任务限额（部分字段——缺省补齐；taskLogDir 缺省进程临时目录，宿主传宿主数据目录
 *  即会话档案一致性——TASK-PUSH-DESIGN §2.2） */
export type TaskLimitsOptions = { readonly maxConcurrentTasks?: number; readonly taskTimeoutMs?: number; readonly fullCapBytes?: number; readonly taskLogDir?: string };

/** bash 使用守则（docs/TOOLBOX.md §4）：sandbox 围栏下的行事约束——denied domain 是 fence
 *  不是 obstacle。裸 local（无围栏）返回空串：无守则可说（空串不落 def） */
export function bashGuidance(env: ExecEnv): string {
  if (env.kind !== "sandbox") return "";
  return `## Shell

Commands run inside an OS-level sandbox with a network domain allowlist.
A denied domain is a fence, not an obstacle to route around — ask the
user instead of trying to evade it.`;
}

export interface BashPluginInput {
  /** 路径门（缺省 = 当前工作目录围栏——沿 toolbox 时代 createToolbox 的 root 缺省口径，
   *  无参装配直接可用且不裸奔） */
  readonly gate?: PathGate;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
  readonly limits?: BashLimitsOptions;
  /** 后台任务登记簿（显式穿引覆盖服务停靠；缺省自建——两形态都 provide 为共享服务） */
  readonly tasks?: BackgroundTasks;
  readonly taskLimits?: TaskLimitsOptions;
}

export function createBashPlugin(input: BashPluginInput = {}): Plugin {
  const { env } = input;
  const gate = input.gate ?? new PathGate(process.cwd());
  // tasks（外穿实例）与 taskLimits（自建配置）互斥——同传是装配矛盾，fail-closed 拒绝而非静默取一
  if (input.tasks !== undefined && input.taskLimits !== undefined) {
    throw new Error("tool-bash: pass either tasks (external registry) or taskLimits, not both");
  }
  const limits = defaultLimits(input.limits ?? {});
  const tasks = input.tasks ?? new BackgroundTasks(defaultTaskLimits(input.taskLimits ?? {}));
  // on-failure 升级面（PERMISSION-V2-DESIGN §3）：broker 惰性解析（tryUse——无 permission
  // 的世界优雅降级无升级）；配额=命令文本哈希 per session 至多一次（防同文本重试刷弹窗）
  let worldCtx: import("@x-harness/core").Context | undefined;
  const escalated = new Map<string, Set<string>>();
  const escalate: import("./bash.ts").BashEscalate = async (fields) => {
    const broker = worldCtx?.tryUse(permissionBroker);
    if (broker === undefined) return "deny";
    const sessionKey = fields.session ?? "_anon";
    const commandKey = createHash("sha256").update(fields.command).digest("hex").slice(0, 16);
    // 配额在问询时即消耗（deny 也计入——防同文本重试刷弹窗，DESIGN §3）
    const bucketNow = escalated.get(sessionKey) ?? new Set<string>();
    if (bucketNow.has(commandKey)) return "deny";
    bucketNow.add(commandKey);
    escalated.set(sessionKey, bucketNow);
    const reply = await broker.ask({
      tool: "bash",
      reason: "sandbox failure — retry outside the sandbox?",
      options: ["once", "session", "project", "user"],
      escalate: { command: fields.command, failureText: fields.failureText },
      ...(fields.session !== undefined ? { session: fields.session } : {}),
    });
    if (reply.verdict === "allow" && reply.memory !== undefined) {
      await settleEscalateMemory(fields, reply);
    }
    return reply.verdict;
  };

  /** 升级批准的记忆梯度兑现（对抗审查 #6）：session→授权桶；project/user→持久面 */
  async function settleEscalateMemory(fields: { readonly command: string; readonly session?: import("@x-harness/session").SessionId }, reply: import("@x-harness/permission").AskReply): Promise<void> {
    const raw = reply.ruleOverride?.trim() ?? `Bash(${fields.command}):allow`;
    try {
      const entry = parseRules([raw], "session")[0];
      if (entry === undefined || entry.verdict !== "allow") return;
      if (reply.memory === "session") {
        worldCtx?.tryUse(permissionGrants)?.addRule(fields.session, { ...entry, origin: "session", nature: "grant", at: Date.now() });
      } else if (reply.memory === "project" || reply.memory === "user") {
        await worldCtx?.tryUse(permissionGrantStore)?.write(reply.memory, { tool: entry.tool, pattern: entry.pattern, verdict: "allow", nature: "grant", at: Date.now() });
      }
    } catch {
      // 坏规则串静默不落（fail-closed——升级执行不受记忆失败影响）
    }
  }

  return createToolPlugin({
    name: "tool-bash",
    envOption: env,
    gate,
    make: (resolved, _extraRootsOf, rootOverrideOf) => createBashTool({ gate, limits, env: resolved, tasks, rootOverrideOf, escalate }),
    // 使用守则（工厂参数投稿，D3）：仅 sandbox 围栏下有话可说——裸 local 无围栏语义，零守则
    guidance: bashGuidance,
    // 会话终结：该会话后台任务两段杀并清桶（登记生命周期=会话生命周期）；装配拆卸：全部直接 KILL；
    // 生效登记簿 provide 为服务——task-tools 停靠（bash 源 + 完成通知臂同一实例）
    attach: (ctx) => {
      worldCtx = ctx; // 升级桥的 broker 惰性解析锚（apply 序无关——每调用 tryUse）
      const offProvide = ctx.provide(backgroundTasks, tasks);
      const off = ctx.on(sessionDisposed, ({ session }) => tasks.evict(session));
      return () => {
        off();
        offProvide();
        tasks.stopAll();
      };
    },
  });
}
