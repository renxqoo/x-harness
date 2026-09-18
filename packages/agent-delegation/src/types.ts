// 子代理契约类型（docs/AGENT-DELEGATION.md §1）。

export interface SubagentType {
  /** 子 system prompt（缺省=装配默认） */
  readonly prompt?: string;
  /** 缺省=父模型（父 options ?? 父末次 request/header 折叠） */
  readonly model?: string;
  readonly provider?: string;
  /** 工具白名单（沿树只收窄：∩ 调用方白名单；含未注册名 spawn 时拒） */
  readonly tools?: readonly string[];
}

export interface DelegationOptions {
  readonly types: Readonly<Record<string, SubagentType>>;
  /** 缺省 3；子再派孙超深度拒；配置垃圾值构造期 throw */
  readonly maxDepth?: number;
  /** 缺省 10；按父计 occupied 子数（登记占、完成/stop 释放） */
  readonly maxConcurrent?: number;
  /** 缺省 8000；agent_output 报告截断上界 */
  readonly reportCap?: number;
}

export interface ChildView {
  readonly agentId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly depth: number;
  readonly status: "running" | "idle" | "stopped";
}
