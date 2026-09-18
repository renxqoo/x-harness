// sections/variables 注册表（docs/SYSTEM-PROMPT.md §1）：同名覆盖、身份守卫注销、惰性变量求值。

import type { PromptVariable, SectionInput, SystemPromptService } from "./types.ts";

export function createPromptRegistry(): SystemPromptService {
  const sections = new Map<string, { readonly input: SectionInput; readonly identity: object }>();
  const variables = new Map<string, { readonly value: PromptVariable; readonly identity: object }>();

  return {
    section: (input: SectionInput) => {
      if (typeof input?.name !== "string" || input.name === "") throw new Error("section name must be a non-empty string");
      if (typeof input.order !== "number" || !Number.isFinite(input.order)) {
        throw new Error(`section "${input.name}" order must be a finite number`);
      }
      if (typeof input.text !== "string") throw new Error(`section "${input.name}" text must be a string`);
      const identity = {};
      sections.set(input.name, { input, identity });
      return () => {
        const current = sections.get(input.name);
        if (current?.identity === identity) sections.delete(input.name);
      };
    },

    variable: (name: string, value: PromptVariable) => {
      if (typeof name !== "string" || name === "") throw new Error("variable name must be a non-empty string");
      if (typeof value !== "string" && typeof value !== "function") {
        throw new Error(`variable "${name}" value must be a string or function`);
      }
      const identity = {};
      variables.set(name, { value, identity });
      return () => {
        const current = variables.get(name);
        if (current?.identity === identity) variables.delete(name);
      };
    },

    assemble: () => {
      const ordered = [...sections.values()]
        .map((entry) => entry.input)
        .sort((a, b) => {
          if (a.order !== b.order) return a.order - b.order;
          return a.name < b.name ? -1 : 1;
        });
      const joined = ordered.map((section) => section.text).join("\n\n");
      return { text: interpolate(joined, variables) };
    },
  };
}

/** 单层插值：未注册变量保持原样；变量值不再递归展开 */
function interpolate(text: string, variables: Map<string, { value: PromptVariable }>): string {
  return text.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (whole, name: string) => {
    const registered = variables.get(name);
    if (registered === undefined) return whole;
    const value = registered.value;
    return typeof value === "function" ? value() : value;
  });
}
