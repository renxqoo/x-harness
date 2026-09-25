// 子代理契约类型（docs/AGENT-DELEGATION.md §1/§2/§7）：类型唯一来源 = .md 文件（U4 裁决）。

import type { SessionId } from "@x-harness/session";
import type { InlineTypeResource } from "./types-inline.ts";

/** .md 加载出的子代理类型（frontmatter + 正文） */
export interface LoadedAgentType {
  readonly name: string;
  /** 注入类型清单用（§7.2） */
  readonly description: string;
  readonly model?: string;
  readonly provider?: string;
  /** 工具白名单（沿树只收窄：∩ 调用方白名单；含未注册名 spawn 时拒） */
  readonly tools?: readonly string[];
  /** 正文 = 子 system prompt（空正文合法 = 装配默认） */
  readonly prompt: string;
}

export interface DelegationOptions {
  /** 类型目录（优先级降序）；缺省 = X_HARNESS_AGENTS_DIRS > <cwd>/.x-harness/agents > ~/.x-harness/agents */
  /** agent 类型目录（必收——插件零目录知识，宿主边沿用 resolveAgentDirs 统一解析；
   *  `[]` = 显式零：不装载任何类型） */
  readonly agentsDirs: readonly string[];
  /** 工作区根（必收，绝对路径）：全部 git 调用的 cwd 锚点（docs/WORKSPACE-ROOT-
   *  INJECTION.md）。不要求是 git 仓根——含 workspaceRoot 的祖先仓即工作区的仓
   *  （归一比较，symlink 逻辑形不误拒）；rev-parse 命中的仓顶落在工作区之外
   *  （GIT_WORK_TREE 异指等注入形态）拒 workspace-not-in-repo；不在任何仓内时
   *  isolation:worktree 拒 not-a-git-repo。hub worker 进程 cwd 是应用启动目录，
   *  绝不可作 git 锚。 */
  readonly workspaceRoot: string;
  /** 内联 builtin 类型层（随 bundle 内联分发的资源——宿主从生成数据模块传入）；
   *  优先级最低（盘上目录同名遮蔽），缺席 = 无内联层 */
  readonly builtinTypes?: readonly InlineTypeResource[];
  /** 跨进程邮箱配置（缺省 = 纯进程内部署：跨进程寻址与 notify_when_idle 拒 invalid-args；
   *  root/timing 由 session-mailbox 插件装配给——单一真相，此处不重复） */
  readonly mailbox?: {
    /** 本进程对外 box 名（真重名活箱构造期 throw——装配 fail-fast） */
    readonly box: string;
    /** 信封路由目的地：宿主 main 会话 id */
    readonly mainSession: SessionId;
  };
  /** 缺省 3；子再派孙超深度拒；配置垃圾值构造期 throw */
  readonly maxDepth?: number;
  /** 缺省 10；按父计 occupied 子数（登记占、完成通知/stop 释放） */
  readonly maxConcurrent?: number;
  /** 缺省 34000；报告截断统一上界——完成通知/finished 事件同一 cap */
  readonly reportCap?: number;
  /** 启动期 worktree 对账清扫开关（缺省开；测试装置可关防跨装置互扫） */
  readonly worktreeSweep?: boolean;
  /** 缺省 32；idle 子驻留上限——超限最旧档化（dispose 会话，WAL 在盘可按名复活） */
  readonly maxResident?: number;
  /** 类型加载/邮箱投递等非致命告警出口（缺省静默降级） */
  readonly onWarn?: (message: string) => void;
  /** 裸模型名 → 归属 provider 反查（宿主接装配目录快照；缺省不反查——model 覆盖
   *  的 provider 回落覆盖序，兼容纯内核部署）。跨 provider 联动（串线修复）：类型
   *  .md 只写 model 不写 provider 时按目录归属联动，不再静默继承父 provider。 */
  readonly resolveProviderOf?: (model: string) => string | undefined;
}

export type ChildView =
  | {
      readonly kind: "subagent";
      readonly agentId: string;
      readonly sessionId: string;
      readonly type: string;
      readonly depth: number;
      readonly status: "running" | "idle" | "stopped";
      /** spawn 任务摘要（spawn 在场恒有；复活自 header 回填——旧档案可能缺席） */
      readonly work?: string;
    }
  | {
      readonly kind: "local-session";
      readonly name: string;
      readonly ref: string;
      readonly status: "running" | "idle";
    };
