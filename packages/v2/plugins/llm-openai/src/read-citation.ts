import type { JsonValue } from "../../../core/src/index";
import type { LlmCitation, LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { record, string } from "../../llm-http/src/index";

export function readOpenaiCitation(
  raw: JsonValue,
  origin: { readonly provider: string; readonly protocol: string },
): LlmResult<LlmCitation> {
  const data = record(raw);
  const type = string(data?.type);

  if (!data || !type) return llmFailure("protocol-error", { phase: "stream" });

  const value = record(data.url_citation) ?? record(data.file_citation) ?? data;
  const position = { kind: "provider" as const, format: `${origin.protocol}/${type}`, value: raw };

  if (data.type === "url_citation" && string(value.url))
    return {
      ok: true,
      value: {
        kind: "url",
        url: value.url as string,
        ...(string(value.title) ? { title: value.title as string } : {}),
        position,
      },
    };

  if (
    ["file_citation", "container_file_citation", "file_path"].includes(type) &&
    string(value.file_id)
  )
    return {
      ok: true,
      value: {
        kind: "file",
        provider: origin.provider,
        protocol: origin.protocol,
        fileId: value.file_id as string,
        ...(string(value.filename) ? { filename: value.filename as string } : {}),
        position,
      },
    };

  return llmFailure("unsupported-feature", { phase: "stream" });
}
