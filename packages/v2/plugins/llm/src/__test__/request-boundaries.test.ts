import { expect, it } from "vitest";
import { readLlmRequest } from "../domain/read-request";
import { readLlmLimits } from "../domain/read-limits";
import { readModelDescription } from "../domain/read-description";
import { checkCapabilities } from "../domain/check-capabilities";
import { createSchemaCache } from "../domain/create-schema-cache";
import type { LlmRequest, LlmResult, ModelDescription } from "../contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const limits = value(readLlmLimits());
const base = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
const tool = {
  name: "tool",
  description: "description",
  strict: false,
  inputSchema: { type: "object" },
};
const description: ModelDescription = {
  protocol: "test",
  model: "m",
  input: ["text", "image", "document", "search-result"],
  developer: true,
  tools: true,
  citations: true,
  output: ["text", "json", "json-schema"],
  providerTools: ["web-search", "file-search"],
  contextWindow: 10000,
  maxOutputTokens: 100,
  reasoning: { efforts: ["low", "high"], budget: true, display: ["text", "summary", "hidden"] },
};
it.each([
  { provider: "p", temperature: 0, topP: 0, maxOutputTokens: 1, timeoutMs: 1, stop: ["END"] },
  { tools: [tool], toolChoice: { name: "tool" } },
  { tools: [], toolChoice: "none" },
  { toolChoice: "auto" },
  { tools: [tool], toolChoice: "required" },
  { output: { type: "json" } },
  { output: { type: "text" } },
  { output: { type: "json-schema", name: "name", strict: true, schema: { type: "object" } } },
  { reasoning: { effort: "high", budgetTokens: 2, display: "summary" } },
  {
    providerTools: [
      { type: "web-search", allowedDomains: ["example.com"] },
      { type: "file-search", vectorStoreIds: ["vs-test"], maxResults: 2 },
    ],
  },
  { providerOptions: { seed: 1 } },
  { model: "m", provider: undefined, signal: new AbortController().signal },
])("valid request controls retain their exact declared shape: %j", (fields) => {
  const result = value(readLlmRequest({ ...base, ...fields }, limits));
  expect(result.model).toBe("m");
});
const invalidFields = [
  { provider: "" },
  { temperature: -1 },
  { temperature: "1" },
  { topP: -1 },
  { topP: "1" },
  { maxOutputTokens: 1.5 },
  { maxOutputTokens: 10000001 },
  { timeoutMs: 1800001 },
  { stop: [] },
  { stop: [""] },
  { stop: 1 },
  { stop: Array(17).fill("a") },
  { tools: null },
  { tools: [null] },
  { tools: [{ ...tool, name: "" }] },
  { tools: [{ ...tool, name: "x.y" }] },
  { tools: [{ ...tool, description: 1 }] },
  { tools: [{ ...tool, strict: "true" }] },
  { tools: [{ ...tool, extra: true }] },
  { toolChoice: "invalid" },
  { toolChoice: { name: "unknown" }, tools: [tool] },
  { toolChoice: { name: "tool", extra: 1 }, tools: [tool] },
  { providerTools: null },
  { providerTools: [null] },
  { providerTools: [{ type: "unknown" }] },
  { providerTools: [{ type: "web-search" }, { type: "web-search" }] },
  { providerTools: [{ type: "web-search", allowedDomains: [] }] },
  { providerTools: [{ type: "web-search", allowedDomains: ["bad/path"] }] },
  { providerTools: [{ type: "file-search", vectorStoreIds: [1] }] },
  { providerTools: [{ type: "file-search", vectorStoreIds: ["v"], maxResults: 0 }] },
  { output: [] },
  { output: { type: "text", name: "unexpected" } },
  { output: { type: "json-schema", name: "bad/name", schema: {} } },
  { output: { type: "json-schema", name: "n", schema: {}, strict: 1 } },
  { reasoning: 1 },
  { reasoning: { effort: "" } },
  { reasoning: { budgetTokens: 0 } },
  { reasoning: { display: "bad" } },
  { reasoning: { unknown: 1 } },
  { providerOptions: [] },
  { providerOptions: { apiKey: "secret" } },
];
it.each(invalidFields)(
  "invalid request controls are rejected before a network call: %j",
  (fields) => {
    expect(readLlmRequest({ ...base, ...fields }, limits)).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  },
);
it.each([
  { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
  { type: "image", source: { type: "base64", data: "YWJj", mediaType: "image/png" } },
  {
    type: "document",
    sourceId: "doc",
    title: "title",
    citations: true,
    source: { type: "text", text: "document" },
  },
  {
    type: "document",
    sourceId: "doc",
    source: { type: "url", url: "https://example.com/doc.pdf" },
  },
  { type: "document", sourceId: "doc", source: { type: "file-id", id: "file-id" } },
  {
    type: "document",
    sourceId: "doc",
    source: { type: "base64", mediaType: "application/pdf", data: "YQ==" },
  },
  {
    type: "search-result",
    sourceId: "search",
    title: "title",
    source: "https://example.com",
    citations: false,
    content: [{ type: "text", text: "result" }],
  },
])("document, image and search input keep explicit provenance: %j", (block) => {
  expect(
    readLlmRequest({ model: "m", messages: [{ role: "user", content: [block] }] }, limits).ok,
  ).toBe(true);
});
it.each([
  null,
  { type: "text", text: 1 },
  { type: "image", source: { type: "url", url: "file:///private" } },
  { type: "image", source: { type: "base64", data: "!bad", mediaType: "image/png" } },
  { type: "image", source: { type: "base64", data: "YQ==", mediaType: "text/plain" } },
  { type: "document", sourceId: "d", source: { type: "file-id", id: "" } },
  { type: "document", sourceId: "d", citations: 1, source: { type: "text", text: "x" } },
  { type: "search-result", sourceId: "s", title: "s", source: "https://x", content: [] },
  { type: "tool-call", callId: "x", name: "tool", input: {} },
])("invalid multimodal content is never silently converted to text: %j", (block) => {
  expect(
    readLlmRequest({ model: "m", messages: [{ role: "user", content: [block] }] }, limits).ok,
  ).toBe(false);
});
it("assistant reasoning and native blocks preserve opaque payloads and role restrictions", () => {
  const continuation = {
    provider: "p",
    protocol: "test",
    model: "m",
    data: { signature: "opaque" },
  };

  for (const block of [
    { type: "reasoning", text: "reason", continuation },
    { type: "reasoning", continuation },
    { type: "provider", continuation },
    { type: "refusal", text: "no" },
  ])
    expect(
      readLlmRequest({ model: "m", messages: [{ role: "assistant", content: [block] }] }, limits)
        .ok,
    ).toBe(true);

  for (const block of [
    { type: "reasoning" },
    { type: "provider", continuation: { ...continuation, model: "" } },
    { type: "image", source: { type: "url", url: "https://x" } },
  ])
    expect(
      readLlmRequest({ model: "m", messages: [{ role: "assistant", content: [block] }] }, limits)
        .ok,
    ).toBe(false);

  expect(
    readLlmRequest(
      { model: "m", messages: [{ role: "system", content: [{ type: "refusal", text: "x" }] }] },
      limits,
    ).ok,
  ).toBe(false);
  expect(
    readLlmRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "document", sourceId: "d", source: { type: "text", text: "a" } },
              { type: "document", sourceId: "d", source: { type: "text", text: "b" } },
            ],
          },
        ],
      },
      limits,
    ).ok,
  ).toBe(false);
});
it("descriptions and capability checks use declared features, bounds and canonical continuation origin", () => {
  expect(value(readModelDescription(description))).toEqual(description);

  for (const delta of [
    { input: [] },
    { input: ["text", "text"] },
    { output: ["unknown"] },
    { providerTools: ["unknown"] },
    { contextWindow: 0 },
    { maxOutputTokens: 1.5 },
    { developer: "yes" },
    { reasoning: { efforts: [1], budget: true, display: ["text"] } },
    { reasoning: { efforts: [], budget: "yes", display: [] } },
    { reasoning: { efforts: [], budget: true, display: ["unknown"] } },
  ])
    expect(readModelDescription({ ...description, ...delta }).ok).toBe(false);

  const full = value(
    readLlmRequest(
      {
        ...base,
        tools: [tool],
        providerTools: [{ type: "web-search" }],
        output: { type: "json-schema", name: "n", schema: {} },
        maxOutputTokens: 100,
        reasoning: { effort: "high", budgetTokens: 1, display: "summary" },
      },
      limits,
    ),
  );
  expect(checkCapabilities(full, description, "p").ok).toBe(true);

  for (const delta of [
    { output: ["text"] },
    { tools: false },
    { providerTools: [] },
    { maxOutputTokens: 99 },
    { reasoning: undefined },
    { reasoning: { ...description.reasoning!, efforts: ["low"] } },
    { reasoning: { ...description.reasoning!, budget: false } },
    { reasoning: { ...description.reasoning!, display: ["text"] } },
  ])
    expect(
      checkCapabilities(full, { ...description, ...delta } as ModelDescription, "p"),
    ).toMatchObject({ ok: false, error: { code: "unsupported-feature" } });

  for (const request of [
    { ...base, messages: [{ role: "developer", content: [{ type: "text", text: "x" }] }] },
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "url", url: "https://x" } }] },
      ],
    },
  ])
    expect(
      checkCapabilities(
        request as LlmRequest,
        { ...description, input: ["text"], developer: false },
        "p",
      ).ok,
    ).toBe(false);

  const continuationRequest: LlmRequest = {
    ...(base as LlmRequest),
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "provider",
            continuation: { provider: "other", protocol: "test", model: "m", data: {} },
          },
        ],
      },
    ],
  };
  expect(checkCapabilities(continuationRequest, description, "p")).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
it("schema validation never coerces, defaults or accepts dangerous keywords and its cache is bounded", () => {
  const cache = createSchemaCache();
  const schema = {
    type: "object",
    properties: {
      value: { type: ["integer", "null"], minimum: 0, maximum: 10 },
      list: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 5 },
        minItems: 1,
        maxItems: 2,
      },
      flag: { type: "boolean", const: true },
      tag: { type: "string", enum: ["a", "b"], description: "tag", title: "Tag" },
    },
    required: ["value"],
    additionalProperties: false,
  };
  const validate = value(cache.compile(schema));
  expect(value(cache.compile(schema))).toBe(validate);
  expect(validate({ value: 1 })).toBe(true);
  expect(validate({ value: "1" })).toBe(false);
  expect(validate({ value: 1, unknown: true })).toBe(false);

  for (const raw of [
    { type: "string", pattern: "(a+)+$" },
    { $ref: "https://example.com" },
    { anyOf: [] },
    { type: "bad" },
    { enum: [] },
    { enum: [{}] },
    { const: {} },
    { type: "array", items: [] },
    { type: "object", properties: [] },
    { type: "object", required: [1] },
    { additionalProperties: {} },
    { type: "string", minLength: -1 },
    { type: "number", minimum: "0" },
    { title: 1 },
  ])
    expect(cache.compile(raw as never).ok).toBe(false);

  for (let i = 0; i < 40; i++) value(cache.compile({ type: "integer", minimum: i }));

  expect(value(cache.compile(schema))).not.toBe(validate);
  cache.close();
  expect(cache.compile({ type: "string" }).ok).toBe(true);
  cache.close();
});
it("continuation rejects each wrong identity axis independently", () => {
  const model = {
    protocol: "test",
    model: "m",
    input: ["text"],
    output: ["text"],
    developer: false,
    tools: true,
    citations: false,
    providerTools: [],
  } as const;

  for (const changed of [{ provider: "other" }, { protocol: "other" }, { model: "other" }]) {
    const request: LlmRequest = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "provider",
              continuation: { provider: "p", protocol: "test", model: "m", data: {}, ...changed },
            },
          ],
        },
      ],
    };
    expect(checkCapabilities(request, model, "p")).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  }
});
