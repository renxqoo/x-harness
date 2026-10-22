import { expect, it } from "vitest";
import { verifyJourney } from "../scripts/agent-live/verify-journey";
import { sse } from "./llm-server";

interface Message {
  role: string;
  content?: { type: string; text: string }[];
  tool_call_id?: string;
}
interface Request {
  messages: Message[];
  tools?: unknown[];
}

function createJourneyServer(
  mode: "complete" | "invalid-input" | "unavailable" | "reasoning-only" | "wrong-total",
) {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Request;
      requests.push(body);

      if (mode === "unavailable")
        return Response.json(
          { error: { code: "inference.no_available_channel" } },
          { status: 503 },
        );

      const round = requests.length;
      const lastText =
        body.messages
          .findLast((message) => message.role === "tool")
          ?.content?.map((part) => part.text)
          .join("") ?? "";
      const name = [
        "read_report",
        "read_invoice",
        "calculate_invoice",
        "save_report",
        "read_report",
      ][round - 1];
      const input = name === "save_report" ? (JSON.parse(lastText) as Record<string, unknown>) : {};

      if (mode === "invalid-input" && name === "save_report") input.total = "wrong";

      let answer = lastText;

      if (!name && mode === "wrong-total")
        answer = JSON.stringify({
          ...(JSON.parse(lastText) as Record<string, unknown>),
          total: 15300,
        });

      const delta = name
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${round}`,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          }
        : {
            role: "assistant",
            content: mode === "reasoning-only" ? "" : answer,
            ...(mode === "reasoning-only" ? { reasoning_content: lastText } : {}),
          };
      return new Response(
        [
          sse({ choices: [{ index: 0, delta }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] }),
          sse({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          sse("[DONE]"),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}

it("a multi-step Agent recovers from a missing report, runs a real calculator, verifies its file and resumes SQLite history without repeating writes", async () => {
  const server = createJourneyServer("complete");

  try {
    const result = await verifyJourney({
      baseUrl: server.baseUrl,
      apiKey: "fixture",
      model: "fixture",
    });
    expect(result).toMatchObject({
      ok: true,
      steps: 6,
      toolCalls: 5,
      checkpoints: 11,
      resumedSteps: 1,
      resumedToolCalls: 0,
      calls: ["read_report", "read_invoice", "calculate_invoice", "save_report", "read_report"],
    });
    expect(result.usage).toHaveLength(6);
    expect(result.resumedUsage).toHaveLength(1);
    expect(server.requests).toHaveLength(7);
    expect(server.requests.at(-1)?.tools ?? []).toEqual([]);
    expect(server.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: [
        { type: "text", text: '{"isError":true}' },
        {
          type: "text",
          text: "Report missing. Read the invoice, calculate it, save the report, then read it again.",
        },
      ],
    });
  } finally {
    await server.close();
  }
}, 20000);

it.each(["reasoning-only", "wrong-total"] as const)(
  "a %s final answer cannot masquerade as a verified visible report",
  async (mode) => {
    const server = createJourneyServer(mode);

    try {
      await expect(
        verifyJourney({ baseUrl: server.baseUrl, apiKey: "fixture", model: "fixture" }),
      ).rejects.toThrow(
        mode === "reasoning-only" ? "visible JSON report" : "lost the verified total",
      );
      expect(server.requests).toHaveLength(6);
    } finally {
      await server.close();
    }
  },
  20000,
);

it("an unavailable model rejects the Agent journey instead of reporting a successful e2e", async () => {
  const server = createJourneyServer("unavailable");

  try {
    await expect(
      verifyJourney({ baseUrl: server.baseUrl, apiKey: "fixture", model: "fixture" }),
    ).rejects.toThrow("model-failed");
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});

it("malformed model arguments stop the multi-step journey before a report write", async () => {
  const server = createJourneyServer("invalid-input");

  try {
    await expect(
      verifyJourney({ baseUrl: server.baseUrl, apiKey: "fixture", model: "fixture" }),
    ).rejects.toThrow("invalid-model-output");
    expect(server.requests).toHaveLength(4);
  } finally {
    await server.close();
  }
}, 20000);
