// System-Prompt 契约类型（docs/SYSTEM-PROMPT.md §1）。

export interface SectionSpec {
  readonly name: string;
  /** 置于目标段之后（缺席锚 no-op）；与 before 互斥 */
  readonly after?: string;
  /** 置于目标段之前（对偶） */
  readonly before?: string;
  /** 静态文本或 assemble 期惰性函数（配置/环境感知）。函数抛错 → 该段降级
   *  `[section <name> render error: <msg>]` 占位不中断（段级降级，对齐变量级语义）；
   *  函数须会话内确定——间歇抛错会使 anchorSystem 逐步落 replace 事件（可观测告警面） */
  readonly text: string | (() => string);
}

export type PromptVariable = string | (() => string);

export interface AssembledPrompt {
  readonly text: string;
  /** sha256 前 16 hex——KV cache 前缀命中观测 */
  readonly fingerprint: string;
}

export interface SystemPromptService {
  section(spec: SectionSpec): () => void;
  /** 会话层注册面（W2C，ELEVATION-DESIGN §2.1）：锚定子集——会话段只锚根层段名；
   *  同名会话段顶替根段位（覆盖）；变量不分层（世界级——DESIGN §3 裁决） */
  scoped(sessionId: string): { section(spec: SectionSpec): () => void };
  variable(name: string, value: PromptVariable): () => void;
  /** 合并投影：根层 ∪ 该会话层（缺省参会话无关 = 纯根层，向后兼容） */
  assemble(options?: { readonly sessionId?: string }): AssembledPrompt;
}
