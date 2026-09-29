export interface SectionSpec {
  readonly name: string;
  readonly after?: string;
  readonly before?: string;
  readonly text: string | (() => string);
}

export type PromptVariable = string | (() => string);

export interface AssembledPrompt {
  readonly text: string;
  readonly fingerprint: string;
}

export interface SystemPromptService {
  section(spec: SectionSpec): () => void;
  scoped(sessionId: string): { section(spec: SectionSpec): () => void };
  variable(name: string, value: PromptVariable): () => void;
  assemble(options?: { readonly sessionId?: string }): AssembledPrompt;
}
