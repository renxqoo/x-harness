import type {
  JsonObject,
  ProviderEvent,
  ProviderEnd,
  LlmResult,
  FinishReason,
  LlmBlockStart,
} from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { readFrame, record, string, integer, readProviderError } from "../../llm-http/src/index";
import type { ProtocolInput, ProtocolDecoder, DecodedFrame } from "../../llm-http/src/index";
import { readResponsesUsage } from "./read-responses-usage";
import { readOpenaiCitation } from "./read-citation";
import { createTextTracker } from "./create-text-tracker";
type Tracker = ReturnType<typeof createTextTracker>;
interface Part {
  id: string;
  type: string;
  ended: boolean;
  tracker: Tracker;
  done: boolean;
}
interface Item {
  readonly id: string;
  readonly type: string;
  readonly index: number;
  readonly blocks: Map<number, Part>;
  ended: boolean;
  argsDone: boolean;
  summaries: Map<number, Part>;
}

export function createResponsesDecoder(input: ProtocolInput): ProtocolDecoder {
  const items = new Map<number, Item>();
  const ids = new Set<string>();
  let responseId: string | undefined;
  let end: ProviderEnd | undefined;
  let sequence = -1;
  let count = 0;
  let calls = false;
  let refusal = false;
  const budget = { bytes: 0, max: input.limits.maxOutputBytes };

  const invalid = () => llmFailure("protocol-error", { phase: "stream" });

  return {
    accept(frame): LlmResult<DecodedFrame> {
      if (end) return invalid();

      const parsed = readFrame(frame);

      if (!parsed.ok) return parsed;

      const data = parsed.value;
      const type = string(data.type);
      const events: ProviderEvent[] = [];

      if (
        !type ||
        (frame.event && frame.event !== "message" && frame.event !== type) ||
        (data.sequence_number !== undefined &&
          (integer(data.sequence_number) === undefined ||
            (data.sequence_number as number) <= sequence))
      )
        return invalid();

      if (data.sequence_number !== undefined) sequence = data.sequence_number as number;

      if (type === "error") return readProviderError(data);

      if (type === "response.created") {
        const response = record(data.response);

        if (responseId || !string(response?.id)) return invalid();

        responseId = response!.id as string;
        events.push({
          type: "response-info",
          info: {
            protocol: input.model.protocol,
            responseId,
            ...(string(response!.model) ? { model: response!.model as string } : {}),
            ...(integer(response!.created_at) !== undefined
              ? { createdAt: (response!.created_at as number) * 1000 }
              : {}),
          },
        });
      } else if (!responseId) return invalid();
      else if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
        const response = record(data.response);

        if (!response || response.id !== responseId || response.status !== type.slice(9))
          return invalid();

        if (type === "response.failed") return readProviderError(response.error ?? {});

        let reason: FinishReason = { kind: "stop" };

        if (calls) reason = { kind: "tool-calls" };
        else if (refusal) reason = { kind: "refusal" };

        let rawReason = response.status as string;

        if (type === "response.incomplete") {
          const why = string(record(response.incomplete_details)?.reason);

          if (!why) return invalid();

          rawReason = why;

          if (why === "max_output_tokens") reason = { kind: "length", limit: "output" };
          else if (why === "content_filter") reason = { kind: "content-filter" };
          else reason = { kind: "other", raw: why };
        }

        if (type === "response.completed" && [...items.values()].some((item) => !item.ended))
          return invalid();

        for (const item of items.values())
          for (const block of item.blocks.values())
            if (!block.ended) {
              block.ended = true;
              events.push({ type: "block-end", id: block.id, status: "incomplete" });
            }

        if (response.usage !== undefined && response.usage !== null) {
          const usage = readResponsesUsage(response.usage);

          if (!usage.ok) return usage;

          events.push({ type: "usage", usage: usage.value });
        }

        end = { reason, rawReason };
      } else if (type === "response.in_progress" || type === "response.queued") {
        const response = record(data.response);

        if (!response || response.id !== responseId) return invalid();
      } else if (type === "response.output_item.added") {
        const raw = record(data.item);
        const index = integer(data.output_index);
        const id = string(raw?.id);
        const kind = string(raw?.type);

        if (
          !raw ||
          index === undefined ||
          !id ||
          !kind ||
          items.has(index) ||
          ids.has(id) ||
          items.size >= input.limits.maxBlocks
        )
          return invalid();

        if (
          ![
            "message",
            "function_call",
            "reasoning",
            "web_search_call",
            "file_search_call",
          ].includes(kind)
        )
          return llmFailure("unsupported-feature", { phase: "stream" });

        const item: Item = {
          id,
          type: kind,
          index,
          blocks: new Map(),
          ended: false,
          argsDone: false,
          summaries: new Map(),
        };
        items.set(index, item);
        ids.add(id);

        if (kind === "message") {
          if (raw.role !== "assistant" || !Array.isArray(raw.content) || raw.content.length)
            return invalid();
        } else {
          const blockId = `responses-${count++}`;
          item.blocks.set(0, {
            id: blockId,
            type: kind,
            ended: false,
            done: false,
            tracker: createTextTracker(
              kind === "function_call"
                ? input.limits.maxToolInputBytes
                : input.limits.maxContinuationBytes,
              budget,
            ),
          });
          let shape: LlmBlockStart;

          if (kind === "function_call") shape = { id: blockId, kind: "tool-call" };
          else if (kind === "reasoning")
            shape = { id: blockId, kind: "reasoning", visibility: "summary" };
          else shape = { id: blockId, kind: "provider", providerType: kind };

          events.push({ type: "block-start", block: shape });

          if (kind === "function_call") {
            if (
              !string(raw.call_id) ||
              !string(raw.name) ||
              (raw.arguments !== undefined && raw.arguments !== "")
            )
              return invalid();

            calls = true;
            events.push(
              {
                type: "tool-call-delta",
                id: blockId,
                field: "callId",
                delta: raw.call_id as string,
              },
              { type: "tool-call-delta", id: blockId, field: "name", delta: raw.name as string },
            );
          }
        }
      } else {
        const index = integer(data.output_index);
        const item = index !== undefined ? items.get(index) : undefined;

        if (!item || item.ended || (data.item_id !== undefined && data.item_id !== item.id))
          return invalid();

        const partIndex = integer(data.content_index);
        const block = item.blocks.get(item.type === "message" ? (partIndex ?? -1) : 0);

        if (type === "response.output_item.done") {
          const raw = record(data.item);

          if (!raw || raw.id !== item.id || raw.type !== item.type) return invalid();

          if (item.type === "message") {
            if ([...item.blocks.values()].some((b) => !b.ended)) return invalid();
          } else {
            if (!block || block.ended) return invalid();

            if (
              item.type === "function_call" &&
              (!item.argsDone || raw.arguments !== block.tracker.value())
            )
              return invalid();

            if (item.type === "reasoning") {
              if ([...item.summaries.values()].some((part) => !part.ended)) return invalid();

              const summaries = raw.summary;

              if (
                !Array.isArray(summaries) ||
                summaries.length !== item.summaries.size ||
                summaries.some(
                  (part, index) =>
                    record(part)?.text !== item.summaries.get(index)?.tracker.value(),
                )
              )
                return invalid();

              for (const part of item.summaries.values()) part.tracker.close();

              item.summaries.clear();
            }

            if (item.type === "reasoning" || item.type.endsWith("_search_call")) {
              if (item.type.endsWith("_search_call"))
                events.push({
                  type: "provider-event",
                  scope: "block",
                  id: block.id,
                  name: `openai/${item.type}`,
                  data: raw,
                });

              events.push({
                type: "continuation",
                id: block.id,
                value: {
                  provider: input.provider,
                  protocol: input.model.protocol,
                  model: input.model.canonicalModel ?? input.request.model,
                  data: raw,
                },
              });
            }

            block.tracker.close();
            block.ended = true;
            events.push({
              type: "block-end",
              id: block.id,
              status: raw.status === "incomplete" ? "incomplete" : "complete",
            });
          }

          item.ended = true;
        } else if (type === "response.content_part.added") {
          const part = record(data.part);

          if (
            item.type !== "message" ||
            partIndex === undefined ||
            block ||
            !part ||
            !["output_text", "refusal"].includes(part.type as string) ||
            count >= input.limits.maxBlocks
          )
            return invalid();

          const id = `responses-${count++}`;
          const tracker = createTextTracker(input.limits.maxEventBytes, budget);
          item.blocks.set(partIndex, {
            id,
            type: part.type as string,
            ended: false,
            tracker,
            done: false,
          });
          const refused = part.type === "refusal";
          const initial = refused ? part.refusal : part.text;

          if (typeof initial !== "string") return invalid();

          const tracked = tracker.append(initial);

          if (!tracked.ok) return tracked;

          events.push({ type: "block-start", block: { id, kind: refused ? "refusal" : "text" } });

          if (initial)
            events.push({ type: refused ? "refusal-delta" : "text-delta", id, delta: initial });

          refusal ||= refused;
        } else if (!block || block.ended) return invalid();
        else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
          const refusalDelta = type === "response.refusal.delta";

          if (
            block.type !== (refusalDelta ? "refusal" : "output_text") ||
            typeof data.delta !== "string"
          )
            return invalid();

          const tracked = block.tracker.append(data.delta);

          if (!tracked.ok) return tracked;

          refusal ||= refusalDelta;
          events.push({
            type: refusalDelta ? "refusal-delta" : "text-delta",
            id: block.id,
            delta: data.delta,
          });
        } else if (type === "response.function_call_arguments.delta") {
          if (item.type !== "function_call" || item.argsDone || typeof data.delta !== "string")
            return invalid();

          const tracked = block.tracker.append(data.delta);

          if (!tracked.ok) return tracked;

          events.push({ type: "tool-call-delta", id: block.id, field: "input", delta: data.delta });
        } else if (type === "response.function_call_arguments.done") {
          if (item.type !== "function_call" || item.argsDone || typeof data.arguments !== "string")
            return invalid();

          const completed = block.tracker.complete(data.arguments);

          if (!completed.ok) return completed;

          if (completed.value)
            events.push({
              type: "tool-call-delta",
              id: block.id,
              field: "input",
              delta: completed.value,
            });

          item.argsDone = true;
        } else if (type === "response.output_text.annotation.added") {
          if (block.type !== "output_text") return invalid();

          const citation = readOpenaiCitation(data.annotation ?? null, {
            provider: input.provider,
            protocol: input.model.protocol,
          });

          if (!citation.ok) return citation;

          events.push({ type: "citation", id: block.id, citation: citation.value });
        } else if (type === "response.content_part.done") {
          const part = record(data.part);

          if (item.type !== "message" || !part || part.type !== block.type) return invalid();

          const completed = block.tracker.complete(
            block.type === "refusal" ? part.refusal : part.text,
          );

          if (!completed.ok) return completed;

          if (completed.value)
            events.push({
              type: block.type === "refusal" ? "refusal-delta" : "text-delta",
              id: block.id,
              delta: completed.value,
            });

          block.tracker.close();
          block.ended = true;
          events.push({
            type: "block-end",
            id: block.id,
            status: data.status === "incomplete" ? "incomplete" : "complete",
          });
        } else if (type === "response.output_text.done" || type === "response.refusal.done") {
          if (
            block.done ||
            block.type !== (type === "response.refusal.done" ? "refusal" : "output_text")
          )
            return invalid();

          const completed = block.tracker.complete(
            block.type === "refusal" ? data.refusal : data.text,
          );

          if (!completed.ok) return completed;

          if (completed.value)
            events.push({
              type: block.type === "refusal" ? "refusal-delta" : "text-delta",
              id: block.id,
              delta: completed.value,
            });

          block.done = true;
        } else if (type.startsWith("response.reasoning_summary_")) {
          const index = integer(data.summary_index);

          if (item.type !== "reasoning" || index === undefined || index >= input.limits.maxBlocks)
            return invalid();

          let part = item.summaries.get(index);

          if (type === "response.reasoning_summary_part.added") {
            const raw = record(data.part);

            if (part || !raw || raw.type !== "summary_text" || typeof raw.text !== "string")
              return invalid();

            part = {
              id: block.id,
              type: "summary_text",
              ended: false,
              done: false,
              tracker: createTextTracker(input.limits.maxContinuationBytes, budget),
            };
            item.summaries.set(index, part);
            const tracked = part.tracker.append(raw.text);

            if (!tracked.ok) return tracked;

            if (raw.text) events.push({ type: "reasoning-delta", id: block.id, delta: raw.text });
          } else if (!part || part.ended) return invalid();
          else if (type === "response.reasoning_summary_text.delta") {
            if (typeof data.delta !== "string" || part.done) return invalid();

            const tracked = part.tracker.append(data.delta);

            if (!tracked.ok) return tracked;

            events.push({ type: "reasoning-delta", id: block.id, delta: data.delta });
          } else if (
            type === "response.reasoning_summary_text.done" ||
            type === "response.reasoning_summary_part.done"
          ) {
            if (type.endsWith("text.done") && part.done) return invalid();

            const completed = part.tracker.complete(
              type.endsWith("part.done") ? record(data.part)?.text : data.text,
            );

            if (!completed.ok) return completed;

            if (completed.value)
              events.push({ type: "reasoning-delta", id: block.id, delta: completed.value });

            part.done = true;

            if (type.endsWith("part.done")) part.ended = true;
          } else return llmFailure("unsupported-feature");
        } else if (
          /^response\.(web_search_call|file_search_call)\.(in_progress|searching|completed)$/.test(
            type,
          )
        ) {
          if (!type.startsWith(`response.${item.type}.`)) return invalid();

          events.push({
            type: "provider-event",
            scope: "block",
            id: block.id,
            name: type,
            data: data as JsonObject,
          });
        } else return llmFailure("unsupported-feature", { phase: "stream" });
      }

      return { ok: true, value: { events, stop: end !== undefined } };
    },
    finish() {
      return end ? { ok: true, value: end } : invalid();
    },
  };
}
