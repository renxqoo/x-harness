// 子代理契约类型（docs/AGENT-DELEGATION.md §1/§2/§7）：类型唯一来源 = .md 文件（U4 裁决）。

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
  readonly agentsDirs?: readonly string[];
  /** 缺省 3；子再派孙超深度拒；配置垃圾值构造期 throw */
  readonly maxDepth?: number;
  /** 缺省 10；按父计 occupied 子数（登记占、完成通知/stop 释放） */
  readonly maxConcurrent?: number;
  /** 缺省 8000；agent_output 报告截断上界 */
  readonly reportCap?: number;
  /** 类型加载告警出口（坏 .md 拒注册等——缺省静默降级） */
  readonly onWarn?: (message: string) => void;
}

export interface ChildView {
  readonly name: string;
  readonly ref: string;
  readonly kind: "subagent";
  readonly agentId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly depth: number;
  readonly status: "running" | "idle" | "stopped";
}
