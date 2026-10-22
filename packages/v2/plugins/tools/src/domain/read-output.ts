import type { ToolOutput, ToolsResult } from "../contracts/types";
import { readJson } from "./read-json";
import { keys, object } from "./read-values";
import { fail } from "./fail";

export function readOutput(raw: unknown, maxBytes: number): ToolsResult<ToolOutput> {
  const parsed = readJson(raw, { maxBytes });

  if (!parsed.ok)
    return parsed.error.source === "tools" && parsed.error.code === "capacity-exceeded"
      ? parsed
      : fail("invalid-output");

  const value = parsed.value;

  if (
    !object(value) ||
    !keys(value, ["content", "structured", "isError"]) ||
    !Array.isArray(value.content) ||
    (value.isError !== undefined && typeof value.isError !== "boolean") ||
    (value.structured !== undefined && !object(value.structured))
  )
    return fail("invalid-output");

  for (const block of value.content) {
    if (!object(block)) return fail("invalid-output");

    if (block.type === "text") {
      if (!keys(block, ["type", "text"]) || typeof block.text !== "string")
        return fail("invalid-output");
    } else if (block.type === "image") {
      const source = block.source;

      if (!keys(block, ["type", "source"]) || !object(source)) return fail("invalid-output");

      if (source.type === "url") {
        if (!keys(source, ["type", "url"]) || typeof source.url !== "string")
          return fail("invalid-output");

        try {
          if (!["http:", "https:"].includes(new URL(source.url).protocol))
            return fail("invalid-output");
        } catch {
          return fail("invalid-output");
        }
      } else if (source.type === "base64") {
        if (
          !keys(source, ["type", "mediaType", "data"]) ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            source.mediaType as string,
          ) ||
          typeof source.data !== "string" ||
          !source.data.length ||
          source.data.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)
        )
          return fail("invalid-output");
      } else return fail("invalid-output");
    } else return fail("invalid-output");
  }

  return { ok: true, value: value as unknown as ToolOutput };
}
