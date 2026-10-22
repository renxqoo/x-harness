import { expect, it } from "vitest";
import type { LlmLimits, LlmResult, ProviderEvent } from "../../../llm/src/contracts";
import { readLlmLimits } from "../../../llm/src/provider";
import type { ProtocolInput } from "../../../llm-http/src/index";
import { createResponsesDecoder } from "../create-responses-decoder";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

function input(limits: Partial<LlmLimits> = {}): ProtocolInput {
  return {
    provider: "p",
    request: { model: "alias", messages: [] },
    model: {
      model: "alias",
      canonicalModel: "canonical",
      protocol: "openai-responses",
      input: ["text"],
      output: ["text"],
      developer: true,
      tools: true,
      citations: true,
      providerTools: ["web-search", "file-search"],
    },
    limits: value(readLlmLimits(limits)),
  };
}

function fixture(limits: Partial<LlmLimits> = {}) {
  const decoder = createResponsesDecoder(input(limits));

  const accept = (data: unknown, event = "message") =>
    decoder.accept({ event, data: JSON.stringify(data) });

  value(accept({ type: "response.created", response: { id: "r" } }));
  return { decoder, accept };
}

function item(kind: string, id = "item") {
  return { type: "response.output_item.added", output_index: 0, item: { type: kind, id } };
}

it.each(["web_search_call", "file_search_call"])(
  "Responses %s retains progress and the completed provider continuation",
  (kind) => {
    const f = fixture();
    value(f.accept(item(kind)));
    value(f.accept({ type: "response.queued", response: { id: "r" } }));
    value(f.accept({ type: "response.in_progress", response: { id: "r" } }));
    const events: ProviderEvent[] = [];

    for (const stage of ["in_progress", "searching", "completed"]) {
      const progress = { type: `response.${kind}.${stage}`, output_index: 0, item_id: "item" };
      events.push(...value(f.accept(progress)).events);
      expect(events).toContainEqual({
        type: "provider-event",
        scope: "block",
        id: "responses-0",
        name: progress.type,
        data: progress,
      });
    }

    const completed = { type: kind, id: "item", status: "incomplete", results: [] };
    const ended = value(
      f.accept({ type: "response.output_item.done", output_index: 0, item: completed }),
    );
    expect(ended.events).toEqual([
      {
        type: "provider-event",
        scope: "block",
        id: "responses-0",
        name: `openai/${kind}`,
        data: completed,
      },
      {
        type: "continuation",
        id: "responses-0",
        value: { provider: "p", protocol: "openai-responses", model: "canonical", data: completed },
      },
      { type: "block-end", id: "responses-0", status: "incomplete" },
    ]);
    expect(
      value(f.accept({ type: "response.completed", response: { id: "r", status: "completed" } }))
        .stop,
    ).toBe(true);
    expect(f.decoder.finish()).toEqual({
      ok: true,
      value: { reason: { kind: "stop" }, rawReason: "completed" },
    });
  },
);

it("Responses reasoning snapshots emit missing suffixes exactly once and require each summary to close", () => {
  const f = fixture();
  value(f.accept(item("reasoning")));
  expect(
    value(
      f.accept({
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "first" },
      }),
    ).events,
  ).toEqual([{ type: "reasoning-delta", id: "responses-0", delta: "first" }]);
  expect(
    value(
      f.accept({
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "first second",
      }),
    ).events,
  ).toEqual([{ type: "reasoning-delta", id: "responses-0", delta: " second" }]);
  expect(
    value(
      f.accept({
        type: "response.reasoning_summary_part.done",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "first second" },
      }),
    ).events,
  ).toEqual([]);
  const ended = value(
    f.accept({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "item", type: "reasoning", summary: [{ text: "first second" }] },
    }),
  );
  expect(ended.events).toEqual([
    {
      type: "continuation",
      id: "responses-0",
      value: expect.objectContaining({
        model: "canonical",
        data: { id: "item", type: "reasoning", summary: [{ text: "first second" }] },
      }),
    },
    { type: "block-end", id: "responses-0", status: "complete" },
  ]);
});

it("Responses function arguments can arrive only in the final snapshot without duplicate input", () => {
  const f = fixture();
  const call = { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "" };
  value(f.accept({ type: "response.output_item.added", output_index: 0, item: call }));
  expect(
    value(
      f.accept({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" }),
    ).events,
  ).toEqual([{ type: "tool-call-delta", id: "responses-0", field: "input", delta: "{}" }]);
  value(
    f.accept({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: "{}" },
    }),
  );
  value(f.accept({ type: "response.completed", response: { id: "r", status: "completed" } }));
  expect(f.decoder.finish()).toEqual({
    ok: true,
    value: { reason: { kind: "tool-calls" }, rawReason: "completed" },
  });
});

it.each([
  ["content_filter", { kind: "content-filter" }],
  ["future", { kind: "other", raw: "future" }],
] as const)("Responses incomplete reason %s remains explicit", (reason, expected) => {
  const f = fixture();
  value(
    f.accept({
      type: "response.incomplete",
      response: { id: "r", status: "incomplete", incomplete_details: { reason } },
    }),
  );
  expect(f.decoder.finish()).toEqual({ ok: true, value: { reason: expected, rawReason: reason } });
});

it.each(
  (
    [
      [
        "mismatched named event",
        { type: "response.queued", response: { id: "r" } },
        "response.in_progress",
        "protocol-error",
      ],
      [
        "wrong queued identity",
        { type: "response.queued", response: { id: "other" } },
        "message",
        "protocol-error",
      ],
      ["unsupported output item", item("computer_call"), "message", "unsupported-feature"],
      [
        "wrong terminal identity",
        { type: "response.completed", response: { id: "other", status: "completed" } },
        "message",
        "protocol-error",
      ],
      [
        "missing incomplete reason",
        { type: "response.incomplete", response: { id: "r", status: "incomplete" } },
        "message",
        "protocol-error",
      ],
      [
        "invalid terminal usage",
        {
          type: "response.completed",
          response: { id: "r", status: "completed", usage: { input_tokens: -1 } },
        },
        "message",
        "protocol-error",
      ],
      [
        "stream provider failure",
        { type: "error", code: "context_length_exceeded", message: "private" },
        "message",
        "context-overflow",
      ],
    ] as const
  ).map(([symptom, data, event, code]) => ({ symptom, data, event, code })),
)("Responses rejects $symptom without a finish", ({ data, event, code }) => {
  const f = fixture();
  const result = f.accept(data, event);
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(f.decoder.finish()).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("Responses sequence numbers must advance", () => {
  const f = fixture();
  value(f.accept({ type: "response.queued", response: { id: "r" }, sequence_number: 3 }));
  expect(
    f.accept({ type: "response.in_progress", response: { id: "r" }, sequence_number: 3 }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it("Responses item identifiers cannot be reused", () => {
  const f = fixture();
  value(f.accept(item("reasoning")));
  expect(f.accept({ ...item("reasoning"), output_index: 1 })).toMatchObject({
    ok: false,
    error: { code: "protocol-error" },
  });
});

it("Responses rejects reasoning deltas after the summary text snapshot is complete", () => {
  const f = fixture();
  value(f.accept(item("reasoning")));
  value(
    f.accept({
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
  );
  value(
    f.accept({
      type: "response.reasoning_summary_text.done",
      output_index: 0,
      summary_index: 0,
      text: "complete",
    }),
  );
  expect(
    f.accept({
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: "late",
    }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});

it.each(["duplicate snapshot", "mismatched item snapshot"])(
  "Responses rejects function argument %s",
  (symptom) => {
    const f = fixture();
    const call = {
      type: "function_call",
      id: "fc",
      call_id: "call",
      name: "lookup",
      arguments: "",
    };
    value(f.accept({ type: "response.output_item.added", output_index: 0, item: call }));
    value(
      f.accept({ type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" }),
    );
    expect(
      f.accept(
        symptom === "duplicate snapshot"
          ? { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" }
          : {
              type: "response.output_item.done",
              output_index: 0,
              item: { ...call, arguments: "different" },
            },
      ),
    ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
  },
);

it.each(["initial", "delta", "snapshot"])(
  "Responses reasoning continuation budget rejects oversized %s text",
  (stage) => {
    const f = fixture({ maxContinuationBytes: 3 });
    value(f.accept(item("reasoning")));
    const part = {
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: stage === "initial" ? "😀" : "a" },
    };

    if (stage !== "initial") value(f.accept(part));

    let data: unknown = part;

    if (stage === "delta")
      data = {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "😀",
      };

    if (stage === "snapshot")
      data = {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "abcd",
      };

    const result = f.accept(data);
    expect(result).toMatchObject({ ok: false, error: { code: "capacity-exceeded" } });
  },
);

it("Responses rejects unsupported summary events and mismatched search events", () => {
  const f = fixture();
  value(f.accept(item("reasoning")));
  value(
    f.accept({
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
  );
  expect(
    f.accept({ type: "response.reasoning_summary_future", output_index: 0, summary_index: 0 }),
  ).toMatchObject({ ok: false, error: { code: "unsupported-feature" } });
  const search = fixture();
  value(search.accept(item("web_search_call")));
  expect(
    search.accept({ type: "response.file_search_call.searching", output_index: 0 }),
  ).toMatchObject({ ok: false, error: { code: "protocol-error" } });
});
