import type { JsonValue } from "../../../../core/src/index";
import { object, text, keys, count, httpUrl } from "./read-values";

export function readRequestFields(
  data: Readonly<Record<string, JsonValue>>,
  maxTools: number,
): boolean {
  for (const name of ["provider", "model"])
    if (data[name] !== undefined && !text(data[name], name === "model" ? 256 : 128)) return false;

  if (
    data.temperature !== undefined &&
    (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2)
  )
    return false;

  if (data.topP !== undefined && (typeof data.topP !== "number" || data.topP < 0 || data.topP > 1))
    return false;

  if (
    data.maxOutputTokens !== undefined &&
    (!count(data.maxOutputTokens) || !data.maxOutputTokens || data.maxOutputTokens > 10000000)
  )
    return false;

  if (
    data.stop !== undefined &&
    (!Array.isArray(data.stop) ||
      !data.stop.length ||
      data.stop.length > 16 ||
      !data.stop.every((entry) => text(entry, 4096)))
  )
    return false;

  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.length > maxTools) return false;

    const names = new Set<string>();

    for (const tool of data.tools) {
      if (
        !object(tool) ||
        !keys(tool, ["name", "description", "inputSchema", "strict"]) ||
        !text(tool.name, 64) ||
        !/^[A-Za-z0-9_-]+$/.test(tool.name) ||
        names.has(tool.name) ||
        (tool.description !== undefined && typeof tool.description !== "string") ||
        !object(tool.inputSchema) ||
        (tool.strict !== undefined && typeof tool.strict !== "boolean")
      )
        return false;

      names.add(tool.name);
    }
  }

  if (data.providerTools !== undefined) {
    if (!Array.isArray(data.providerTools) || data.providerTools.length > maxTools) return false;

    const types = new Set<string>();

    for (const tool of data.providerTools) {
      if (!object(tool) || typeof tool.type !== "string" || types.has(tool.type)) return false;

      types.add(tool.type);

      if (tool.type === "web-search") {
        if (
          !keys(tool, ["type", "allowedDomains"]) ||
          (tool.allowedDomains !== undefined &&
            (!Array.isArray(tool.allowedDomains) ||
              !tool.allowedDomains.length ||
              tool.allowedDomains.length > 100 ||
              !tool.allowedDomains.every(
                (entry) =>
                  text(entry, 253) && /^[a-zA-Z0-9.-]+$/.test(entry) && httpUrl(`https://${entry}`),
              )))
        )
          return false;
      } else if (
        tool.type !== "file-search" ||
        !keys(tool, ["type", "vectorStoreIds", "maxResults"]) ||
        !Array.isArray(tool.vectorStoreIds) ||
        !tool.vectorStoreIds.length ||
        tool.vectorStoreIds.length > 16 ||
        !tool.vectorStoreIds.every((entry) => text(entry)) ||
        (tool.maxResults !== undefined &&
          (!count(tool.maxResults) || tool.maxResults < 1 || tool.maxResults > 50))
      )
        return false;
    }
  }

  if (
    data.toolChoice !== undefined &&
    !["auto", "none", "required"].includes(data.toolChoice as string) &&
    (!object(data.toolChoice) ||
      !keys(data.toolChoice, ["name"]) ||
      !text(data.toolChoice.name, 64) ||
      !Array.isArray(data.tools) ||
      !data.tools.some(
        (tool) =>
          object(tool) &&
          tool.name === (data.toolChoice as Readonly<Record<string, JsonValue>>).name,
      ))
  )
    return false;

  if (
    data.reasoning !== undefined &&
    (!object(data.reasoning) ||
      !keys(data.reasoning, ["effort", "budgetTokens", "display"]) ||
      (data.reasoning.effort !== undefined && !text(data.reasoning.effort, 32)) ||
      (data.reasoning.budgetTokens !== undefined &&
        (!count(data.reasoning.budgetTokens) || data.reasoning.budgetTokens < 1)) ||
      (data.reasoning.display !== undefined &&
        !["text", "summary", "hidden"].includes(data.reasoning.display as string)))
  )
    return false;

  if (data.output !== undefined) {
    if (!object(data.output)) return false;

    if (data.output.type === "json-schema") {
      if (
        !keys(data.output, ["type", "name", "schema", "strict"]) ||
        !text(data.output.name, 64) ||
        !/^[A-Za-z0-9_-]+$/.test(data.output.name) ||
        !object(data.output.schema) ||
        (data.output.strict !== undefined && typeof data.output.strict !== "boolean")
      )
        return false;
    } else if (
      !keys(data.output, ["type"]) ||
      !["text", "json"].includes(data.output.type as string)
    )
      return false;
  }

  if (
    data.providerOptions !== undefined &&
    (!object(data.providerOptions) ||
      Object.keys(data.providerOptions).some((key) =>
        [
          "model",
          "stream",
          "messages",
          "input",
          "tools",
          "tool_choice",
          "api_key",
          "apiKey",
          "headers",
          "baseUrl",
          "url",
          "signal",
          "fetch",
          "maxRetries",
          "response_format",
          "output_config",
          "max_tokens",
          "max_completion_tokens",
          "max_output_tokens",
        ].includes(key),
      ))
  )
    return false;

  return true;
}
