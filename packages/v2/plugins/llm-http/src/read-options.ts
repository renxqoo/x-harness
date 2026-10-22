import { readData } from "../../../core/src/validation";
import type { LlmResult } from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import type { HttpOptions, HttpConfig, HttpFetch } from "./types";

export function readHttpOptions(raw: HttpOptions): LlmResult<HttpConfig> {
  const read = readData(raw);

  if (
    !read.ok ||
    Object.keys(read.value).some(
      (key) => !["baseUrl", "apiKey", "headers", "fetch", "now"].includes(key),
    ) ||
    typeof read.value.baseUrl !== "string" ||
    typeof read.value.apiKey !== "string" ||
    !read.value.apiKey ||
    read.value.apiKey.length > 8192 ||
    /[\r\n]/.test(read.value.apiKey) ||
    (read.value.fetch !== undefined && typeof read.value.fetch !== "function") ||
    (read.value.now !== undefined && typeof read.value.now !== "function")
  )
    return llmFailure("invalid-input");

  let baseUrl: string;

  try {
    const url = new URL(read.value.baseUrl);

    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.href.length > 8192
    )
      return llmFailure("invalid-input");

    baseUrl = url.href.replace(/\/$/, "");
  } catch {
    return llmFailure("invalid-input");
  }

  const parsed = readData(read.value.headers ?? {});

  if (!parsed.ok || Object.keys(parsed.value).length > 32) return llmFailure("invalid-input");

  const headers: Record<string, string> = Object.create(null);

  for (const [name, value] of Object.entries(parsed.value)) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(name) ||
      ["authorization", "x-api-key", "content-type", "accept", "content-length", "host"].includes(
        name.toLowerCase(),
      ) ||
      typeof value !== "string" ||
      value.length > 8192 ||
      /[\r\n]/.test(value) ||
      Object.hasOwn(headers, name.toLowerCase())
    )
      return llmFailure("invalid-input");

    headers[name.toLowerCase()] = value;
  }

  return {
    ok: true,
    value: Object.freeze({
      baseUrl,
      apiKey: read.value.apiKey,
      headers: Object.freeze(headers),
      fetch: (read.value.fetch ?? globalThis.fetch) as HttpFetch,
      now: (read.value.now ?? Date.now) as () => number,
    }),
  };
}
