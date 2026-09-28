// Tools 契约类型（docs/TOOLS.md §1.1）：结果即返回值（pi 思想）——concludesTurn/additionalContexts
// 进 outcome，不做 exec 上的方法调用；additionalContexts 仅 text 块（tool_use 会被适配器丢弃）。

import type { Static, TSchema } from "@sinclair/typebox";
import type { ContentBlock, SessionId } from "@x-harness/session";

export type TextBlock = Extract<ContentBlock, { readonly type: "text" }>;

export interface ToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: TSchema;
}

export interface ToolExecContext {
  readonly callId: string;
  readonly name: string;
  readonly signal: AbortSignal;
  /** 调用方会话（agent 调度携带）——工具识别父/血缘寻址 */
  readonly session?: SessionId;
  /** 增量输出通道（可选）：执行中可多次调用的观察回调——不进 WAL、不影响结果；
   *  结果权威仍 = 返回值（「结果即返回值」不变量不动）。实现方自负不抛（观察面纪律）；
   *  可被中间件替换/包裹（与 signal 同类） */
  readonly onOutput?: (delta: string) => void;
  /** 执行指令（permission 裁决产物，dispatch 管线服务端透传——模型入参不可达）：
   *  direct=直通执行；contained=围栏内执行；缺席=参与面缺省（fail-safe 归 contained） */
  readonly exec?: "direct" | "contained";
  /** on-failure 升级资格（档位 askPolicy=on-failure 且本次 contained——工具侧据此
   *  在围栏疑似打挂时发起 escalate ask） */
  readonly escalatable?: true;
}

export interface ToolOutcome {
  readonly content: string;
  readonly isError?: true;
  /** 结构化判别：loop 据此区分 abort 双码（超时/用户取消） */
  readonly aborted?: true;
  /** 工具显式终结 turn（易失：不进任何 session 事件——repair 后丢失是已知语义） */
  readonly concludesTurn?: true;
  readonly additionalContexts?: readonly { readonly content: readonly TextBlock[] }[];
}

/** 工具风险分类闭集（kind 声明词汇单一真相源——permission 路由/规则命名空间消费）：
 *  Read=只读 / Write=写 / Danger=行为不可静态分类需逐次裁决（参数含 command 串） */
export type ToolKind = "Read" | "Write" | "Danger";

export interface ToolDefinition extends ToolSchema {
  /** 严格 true 才可并行（缺省/抛错/非 true 一律 exclusive——fail-closed） */
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  /** 控制类工具（Codex is_builtin_control_tool 同构语义）：agent 自我组织/控制面行为，
   *  非环境副作用——permission 裁决面直通（声明权在工具定义，安全面只认标记不认名单） */
  readonly isControlTool?: true;
  /** 工具类别（闭集三分类——工具风险类别，声明权在工具作者）：
   *  "Read" = 只读（read/grep 类——拒读基线跨工具生效）；"Write" = 写（write/edit 类）；
   *  "Danger" = 行为不可静态分类需逐次裁决，契约 = 参数含 command 串（bash/shell 类）。
   *  内核路由：Read/Write → 文件路径模型（glob 规则，规则前缀同类名）；Danger →
   *  命令语言模型（解析管线，Danger(...) 规则）；**缺席（业务工具不声明）→ 通用面
   *  恒 ask（fail-closed），可经 Tool(名) 规则授权**。kind 透传 facts 供上层（模式
   *  插件/宿主）按类分组施策。服务端独占 */
  readonly kind?: ToolKind;
  /** path 参数是搜索范围而非单一目标（R2：grep 类目录搜索——范围可覆盖拒读文件）。
   *  true = 恒范围；谓词 = 按参数判（grep：目录形/缺席才是范围，明确文件目标不是）。
   *  内核对范围型读做拒读底线的子树判定（有锚相交 deny / 无锚 ask+范围记忆），
   *  且 path 缺席 = 以 root 为范围的合法搜索（不再 pathAbsent 问） */
  readonly readsSubtree?: true | ((args: unknown) => boolean);
  /** 使用守则（纯数据）：工具在场才成立的行事约束——经 tool-core 工厂参数投稿为
   *  system-prompt 段（D3；make() 自带此字段仅作数据不触发停靠——W1 审查 L-1 记录）。
   *  不进 LLM 序列化（schemas() 显式子集映射，guidance 不外漏） */
  readonly guidance?: string;
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolOutcome>;
}

/** 泛型助手（pi 的 defineTool 思想）：保持 Static<T> 参数推断——execute 拿到类型安全的已校验参数 */
export function defineTool<T extends TSchema>(def: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: T;
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  readonly isControlTool?: true;
  readonly kind?: ToolKind;
  readonly readsSubtree?: true | ((args: unknown) => boolean);
  execute(args: Static<T>, ctx: ToolExecContext): Promise<ToolOutcome>;
}): ToolDefinition {
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    inputSchema: def.inputSchema,
    ...(def.isConcurrencySafe !== undefined ? { isConcurrencySafe: def.isConcurrencySafe } : {}),
    ...(def.isControlTool !== undefined ? { isControlTool: def.isControlTool } : {}),
    ...(def.kind !== undefined ? { kind: def.kind } : {}),
    ...(def.readsSubtree !== undefined ? { readsSubtree: def.readsSubtree } : {}),
    // 运行时收到的是经 TypeBox 校验的值；静态收窄由本助手的泛型保证
    execute: def.execute as ToolDefinition["execute"],
  };
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
  /** 归属会话（agent 调度携带）：语义持久检查点据此 flush；缺省=非 agent 调用方 */
  readonly session?: SessionId;
  /** 增量输出通道（可选）：调度方提供，runBody 透传进 ToolExecContext */
  readonly onOutput?: (delta: string) => void;
}

/** pre-execute 决策：allow 可携执行指令（permission 裁决产物——dispatch 管线服务端独占，
 *  gateDecision 白名单校验透传；缺席 = 无指令参与面） */
export type PreExecuteDecision =
  | { readonly kind: "allow"; readonly exec?: "direct" | "contained"; readonly escalatable?: true }
  | { readonly kind: "deny"; readonly reason: string };

/** 会话层工具收窄：可见名白名单或 "deny-all"（全禁） */
export type ToolFilter = readonly string[] | "deny-all";

export interface ToolRegistry {
  /** 重名注册 throw；运行期注册新名合法（schemas 即时反映）；Disposer 由注册方自行绑定 ctx.effect */
  register(def: ToolDefinition): () => void;
  get(name: string): ToolDefinition | undefined;
  /** 分层投影：根层 − 该会话 restriction（缺省参会话无关 = 全量，向后兼容——ELEVATION-DESIGN §2.2）。
   *  只投影不执行门禁的孪生执法面在 agent-loop（allowedTools 喂投影名集） */
  schemas(options?: { readonly sessionId?: string }): readonly ToolSchema[];
  /** 会话层收窄写入面（X15 沿树只收窄）；同会话二次 restrict 覆盖（身份守卫）。
   *  生命周期：sessionDisposed 自动注销（toolsPlugin 挂），或 disposer 手动 */
  scoped(sessionId: string): { restrict(filter: ToolFilter): () => void };
  /** 读回：该会话当前生效 restriction（无 = 未收窄）——delegation 血缘收窄的输入源（W2A） */
  restrictionOf(sessionId: string): ToolFilter | undefined;
  concurrencyOf(name: string, args: unknown): "parallel" | "exclusive";
  dispatch(request: ToolCallRequest): Promise<ToolOutcome>;
}
