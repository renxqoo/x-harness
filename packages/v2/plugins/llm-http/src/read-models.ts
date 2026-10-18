import { readData } from "../../../core/src/validation";
import type { LlmResult, ModelDescription } from "../../llm/src/contracts";
import { readModelDescription, llmFailure } from "../../llm/src/provider";
export type ModelSettings = Partial<Omit<ModelDescription, "protocol" | "model">>;
export function readModels(raw: unknown, protocol: string): LlmResult<Readonly<Record<string, ModelDescription>>> {
  const input = readData(raw); if (!input.ok || !Object.keys(input.value).length || Object.keys(input.value).length > 1024) return llmFailure("invalid-input"); const output: Record<string, ModelDescription> = Object.create(null);
  for (const [name, raw] of Object.entries(input.value)) {
    const read = readData(raw); if (!read.ok || Object.keys(read.value).some((key) => !["canonicalModel", "contextWindow", "maxOutputTokens", "input", "developer", "tools", "citations", "output", "providerTools", "reasoning"].includes(key))) return llmFailure("invalid-input");
    const settings = Object.fromEntries(Object.entries(read.value).filter(([, value]) => value !== undefined)); const model = readModelDescription({ protocol, model: name, input: ["text"], developer: protocol === "openai-responses", tools: true, citations: false, output: ["text"], providerTools: [], ...settings }); if (!model.ok) return model;
    const value = model.value; const displays = value.reasoning?.display ?? [];
    if (protocol === "openai-chat-completions" && (value.providerTools.length || value.input.includes("search-result") || value.reasoning?.budget || displays.some((mode) => mode !== "text"))) return llmFailure("unsupported-feature");
    if (protocol === "openai-responses" && (value.input.includes("search-result") || value.reasoning?.budget || displays.includes("text"))) return llmFailure("unsupported-feature");
    if (protocol === "anthropic-messages" && (value.developer || value.providerTools.length || value.output.includes("json") || displays.includes("text"))) return llmFailure("unsupported-feature");
    output[name] = value;
  }
  return { ok: true, value: Object.freeze(output) };
}
