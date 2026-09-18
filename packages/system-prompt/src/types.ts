// System-Prompt 契约类型（docs/SYSTEM-PROMPT.md §1）。

export type PromptVariable = string | (() => string);

export interface SectionInput {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface SystemPromptService {
  /** 同名覆盖（后者胜）；返回 Disposer，身份守卫注销 */
  section(input: SectionInput): () => void;
  /** {{name}} 插值；函数值每次 assemble 现算 */
  variable(name: string, value: PromptVariable): () => void;
  /** sections 按 (order, name) 升序 join("\n\n") 后单层插值；无 sections → "" */
  assemble(): { readonly text: string };
}
