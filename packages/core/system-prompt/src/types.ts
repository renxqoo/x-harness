// System-Prompt 契约类型（docs/SYSTEM-PROMPT.md §1）。

export interface SectionSpec {
  readonly name: string;
  /** 置于目标段之后（缺席锚 no-op）；与 before 互斥 */
  readonly after?: string;
  /** 置于目标段之前（对偶） */
  readonly before?: string;
  readonly text: string;
}

export type PromptVariable = string | (() => string);

export interface AssembledPrompt {
  readonly text: string;
  /** sha256 前 16 hex——KV cache 前缀命中观测 */
  readonly fingerprint: string;
}

export interface SystemPromptService {
  section(spec: SectionSpec): () => void;
  variable(name: string, value: PromptVariable): () => void;
  assemble(): AssembledPrompt;
}
