import type { LlmProviderService, LlmRequest, LlmResult, JsonObject } from "../contracts";
import { runModel } from "../stream/run-model";
import { createSchemaCache } from "../domain/create-schema-cache";
import { readLlmLimits } from "../domain/read-limits";
import { readModelDescription } from "../domain/read-description";
import { equalJson } from "./equal-json";
import { readLlmJson } from "../domain/read-json";
export type ProviderExpectation =
  | { readonly kind: "text"; readonly text?: string }
  | { readonly kind: "tool-call"; readonly name: string; readonly input?: JsonObject };

export async function verifyLlmProvider(input: {
  readonly service: LlmProviderService;
  readonly provider: string;
  readonly request: LlmRequest;
  readonly expected: ProviderExpectation;
}): Promise<{ readonly checks: readonly string[] }> {
  const checks: string[] = [];

  const check = (name: string, valid: boolean) => {
    if (!valid) throw new Error(`Provider contract failed: ${name}`);

    checks.push(name);
  };

  const limits = readLlmLimits();

  if (!limits.ok) throw new Error("Invalid provider checker limits");

  const schemas = createSchemaCache();
  const controller = new AbortController();
  let terminal = false;
  let callbacks = 0;
  let delayed = false;

  try {
    check(
      "explicit standard output expectation",
      input.expected?.kind === "text" || input.expected?.kind === "tool-call",
    );
    const description = await input.service.describe({
      model: input.request.model,
      signal: controller.signal,
    });
    check("model description", description.ok && readModelDescription(description.value).ok);
    const response = await runModel({
      input: {
        request: input.request,
        collect: true,
        async onEvent(event) {
          check("no output after terminal", !terminal);

          if (event.type === "block-start" && event.block.kind === input.expected.kind) {
            delayed = true;
            await new Promise((done) => setTimeout(done, 5));
          }

          terminal ||= event.type === "finish" || event.type === "error";
          callbacks++;
        },
      },
      provider: input.provider,
      signal: controller.signal,
      limits: limits.value,
      schemas,
      service: input.service,
    });
    check("normalized state and awaited consumer", response.ok);
    check("single completed terminal", terminal && callbacks >= 2);
    check("standard slow-consumer path exercised", delayed);

    if (response.ok) {
      const content = response.value.content ?? [];
      const expected = input.expected;
      const expectedInput =
        expected.kind === "tool-call" && expected.input !== undefined
          ? readLlmJson(expected.input, {
              maxBytes: limits.value.maxToolInputBytes,
              maxDepth: limits.value.maxJsonDepth,
              maxNodes: limits.value.maxJsonNodes,
            })
          : undefined;

      if (expectedInput) check("valid expected tool input", expectedInput.ok);

      if (expected.kind === "text") {
        const text = content
          .filter((block) => block.block.kind === "text")
          .map((block) => block.text ?? "")
          .join("");
        check(
          "expected standard text output",
          text.length > 0 && (expected.text === undefined || expected.text === text),
        );
      } else
        check(
          "expected complete standard tool call",
          content.some(
            (block) =>
              block.call?.name === expected.name &&
              block.call.input.ok &&
              (expected.input === undefined ||
                (expectedInput?.ok === true &&
                  equalJson(block.call.input.value, expectedInput.value))),
          ),
        );
    }

    const cancelled = new AbortController();
    cancelled.abort();
    let emitted = 0;
    const result: LlmResult<unknown> = await input.service.stream({
      request: input.request,
      provider: input.provider,
      signal: cancelled.signal,
      async onEvent() {
        emitted++;
        return { ok: true, value: undefined };
      },
    });
    check(
      "pre-cancellation",
      !result.ok && ["cancelled", "call-cancelled"].includes(result.error.code),
    );
    check("no output for pre-cancelled input", emitted === 0);
    return Object.freeze({ checks: Object.freeze([...new Set(checks)]) });
  } finally {
    controller.abort();
    schemas.close();
  }
}
