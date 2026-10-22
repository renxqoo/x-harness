import type {
  JsonObject,
  LlmResult,
  ProviderEnd,
  ProviderEvent,
  LlmUsage,
  FinishReason,
  LlmBlockStart,
} from "../../llm/src/contracts";
import { llmFailure } from "../../llm/src/provider";
import { readFrame, record, string, integer, readProviderError } from "../../llm-http/src/index";
import type { ProtocolInput, ProtocolDecoder, DecodedFrame } from "../../llm-http/src/index";
import { readAnthropicUsage } from "./read-usage";
import { readAnthropicCitation } from "./read-citation";
interface Block {
  readonly id: string;
  readonly type: string;
  ended: boolean;
  readonly thinking: string[];
  readonly signature: string[];
  bytes: number;
  input: boolean;
  initial?: JsonObject;
  redacted?: string;
}

export function createMessageDecoder(input: ProtocolInput): ProtocolDecoder {
  const blocks = new Map<number, Block>();
  let started = false;
  let stopped = false;
  let end: ProviderEnd | undefined;
  let usage: LlmUsage = { complete: false };
  const encoder = new TextEncoder();

  const invalid = () => llmFailure("protocol-error", { phase: "stream" });

  return {
    accept(frame): LlmResult<DecodedFrame> {
      if (stopped) return invalid();

      const parsed = readFrame(frame);

      if (!parsed.ok) return parsed;

      const data = parsed.value;
      const type = string(data.type);

      if (!type || (frame.event && frame.event !== "message" && frame.event !== type))
        return invalid();

      const events: ProviderEvent[] = [];

      if (type === "error") return readProviderError(data.error ?? {});

      if (type === "ping") return { ok: true, value: { events, stop: false } };

      if (type === "message_start") {
        const message = record(data.message);

        if (
          started ||
          !message ||
          !string(message.id) ||
          message.role !== "assistant" ||
          !Array.isArray(message.content) ||
          message.content.length ||
          message.stop_reason != null
        )
          return invalid();

        started = true;
        events.push({
          type: "response-info",
          info: {
            protocol: input.model.protocol,
            responseId: message.id as string,
            ...(string(message.model) ? { model: message.model as string } : {}),
          },
        });
        const read = readAnthropicUsage(message.usage, usage, false);

        if (!read.ok) return read;

        usage = read.value;
        events.push({ type: "usage", usage });
      } else if (!started) return invalid();
      else if (type === "message_stop") {
        if (!end || [...blocks.values()].some((block) => !block.ended)) return invalid();

        stopped = true;
        usage = { ...usage, complete: true };
        events.push({ type: "usage", usage });
      } else if (type === "message_delta") {
        const delta = record(data.delta);

        if (!delta || end || [...blocks.values()].some((block) => !block.ended)) return invalid();

        if (data.usage !== undefined) {
          const read = readAnthropicUsage(data.usage, usage, false);

          if (!read.ok) return read;

          usage = read.value;
          events.push({ type: "usage", usage });
        }

        if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
          const raw = string(delta.stop_reason);

          if (!raw) return invalid();

          const reason = finishReason(raw, delta.stop_sequence);

          if (!reason.ok) return reason;

          end = { reason: reason.value, rawReason: raw };
        }

        for (const [name, value] of Object.entries(delta))
          if (!["stop_reason", "stop_sequence"].includes(name))
            events.push({
              type: "provider-event",
              scope: "request",
              name: `anthropic/${name}`,
              data: value,
            });
      } else {
        const index = integer(data.index);

        if (index === undefined || index >= input.limits.maxBlocks || end) return invalid();

        const block = blocks.get(index);

        if (type === "content_block_start") {
          const raw = record(data.content_block);
          const kind = string(raw?.type);

          if (block || !raw || !kind || blocks.size >= input.limits.maxBlocks) return invalid();

          if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(kind))
            return llmFailure("unsupported-feature", { phase: "stream" });

          const b: Block = {
            id: `anthropic-${index}`,
            type: kind,
            ended: false,
            thinking: [],
            signature: [],
            bytes: 0,
            input: false,
          };
          blocks.set(index, b);
          let shape: LlmBlockStart;

          if (kind === "text") shape = { id: b.id, kind: "text" };
          else if (kind === "tool_use") shape = { id: b.id, kind: "tool-call" };
          else {
            let visibility: "hidden" | "summary" | "text" = "summary";

            if (kind === "redacted_thinking" || input.request.reasoning?.display === "hidden")
              visibility = "hidden";
            else if (input.request.reasoning?.display === "summary") visibility = "summary";

            shape = { id: b.id, kind: "reasoning", visibility };
          }

          events.push({ type: "block-start", block: shape });

          if (kind === "text") {
            if (typeof raw.text !== "string") return invalid();

            if (raw.text) events.push({ type: "text-delta", id: b.id, delta: raw.text });

            if (Array.isArray(raw.citations))
              for (const citation of raw.citations) {
                const read = readAnthropicCitation(citation, input);

                if (!read.ok) return read;

                events.push({ type: "citation", id: b.id, citation: read.value });
              }
          } else if (kind === "tool_use") {
            const initial = record(raw.input);

            if (!string(raw.id) || !string(raw.name) || !initial) return invalid();

            b.initial = initial;
            events.push(
              { type: "tool-call-delta", id: b.id, field: "callId", delta: raw.id as string },
              { type: "tool-call-delta", id: b.id, field: "name", delta: raw.name as string },
            );
          } else if (kind === "thinking") {
            if (
              typeof raw.thinking !== "string" ||
              (raw.signature !== undefined && typeof raw.signature !== "string")
            )
              return invalid();

            b.bytes = encoder.encode(raw.thinking + (raw.signature ?? "")).length;

            if (b.bytes > input.limits.maxContinuationBytes) return llmFailure("capacity-exceeded");

            if (raw.thinking) {
              b.thinking.push(raw.thinking);
              events.push({ type: "reasoning-delta", id: b.id, delta: raw.thinking });
            }

            if (typeof raw.signature === "string" && raw.signature) {
              b.signature.push(raw.signature);
              events.push({ type: "signature-delta", id: b.id, delta: raw.signature });
            }
          } else {
            if (!string(raw.data)) return invalid();

            b.redacted = raw.data as string;
            b.bytes = encoder.encode(b.redacted).length;

            if (b.bytes > input.limits.maxContinuationBytes) return llmFailure("capacity-exceeded");
          }
        } else if (!block || block.ended) return invalid();
        else if (type === "content_block_delta") {
          const delta = record(data.delta);

          if (!delta) return invalid();

          if (
            delta.type === "text_delta" &&
            block.type === "text" &&
            typeof delta.text === "string"
          )
            events.push({ type: "text-delta", id: block.id, delta: delta.text });
          else if (
            delta.type === "input_json_delta" &&
            block.type === "tool_use" &&
            typeof delta.partial_json === "string"
          ) {
            if (Object.keys(block.initial ?? {}).length) return invalid();

            block.input = true;
            events.push({
              type: "tool-call-delta",
              id: block.id,
              field: "input",
              delta: delta.partial_json,
            });
          } else if (
            (delta.type === "thinking_delta" || delta.type === "signature_delta") &&
            block.type === "thinking"
          ) {
            const value = delta.type === "thinking_delta" ? delta.thinking : delta.signature;

            if (
              typeof value !== "string" ||
              (delta.type === "thinking_delta" && block.signature.length)
            )
              return invalid();

            block.bytes += encoder.encode(value).length;

            if (block.bytes > input.limits.maxContinuationBytes)
              return llmFailure("capacity-exceeded");

            (delta.type === "thinking_delta" ? block.thinking : block.signature).push(value);
            events.push({
              type: delta.type === "thinking_delta" ? "reasoning-delta" : "signature-delta",
              id: block.id,
              delta: value,
            });
          } else if (delta.type === "citations_delta" && block.type === "text") {
            const citation = readAnthropicCitation(delta.citation, input);

            if (!citation.ok) return citation;

            events.push({ type: "citation", id: block.id, citation: citation.value });
          } else return invalid();
        } else if (type === "content_block_stop") {
          if (block.type === "tool_use" && !block.input)
            events.push({
              type: "tool-call-delta",
              id: block.id,
              field: "input",
              delta: JSON.stringify(block.initial),
            });

          if (block.type === "thinking" || block.type === "redacted_thinking") {
            if (block.type === "thinking" && !block.signature.join("")) return invalid();

            const value: JsonObject =
              block.type === "thinking"
                ? {
                    type: "thinking",
                    thinking: block.thinking.join(""),
                    signature: block.signature.join(""),
                  }
                : { type: "redacted_thinking", data: block.redacted! };
            events.push({
              type: "continuation",
              id: block.id,
              value: {
                provider: input.provider,
                protocol: input.model.protocol,
                model: input.model.canonicalModel ?? input.request.model,
                data: value,
              },
            });
            block.thinking.length = 0;
            block.signature.length = 0;
            block.redacted = undefined;
          }

          block.ended = true;
          events.push({ type: "block-end", id: block.id, status: "complete" });
        } else return llmFailure("unsupported-feature", { phase: "stream" });
      }

      return { ok: true, value: { events, stop: stopped } };
    },
    finish() {
      return stopped && end ? { ok: true, value: end } : invalid();
    },
  };
}

function finishReason(raw: string, sequence: unknown): LlmResult<FinishReason> {
  if (raw === "end_turn" || raw === "stop_sequence") {
    if (sequence !== undefined && sequence !== null && typeof sequence !== "string")
      return llmFailure("protocol-error");

    return {
      ok: true,
      value: { kind: "stop", ...(typeof sequence === "string" ? { stopSequence: sequence } : {}) },
    };
  }

  if (raw === "tool_use") return { ok: true, value: { kind: "tool-calls" } };

  if (raw === "max_tokens" || raw === "model_context_window_exceeded")
    return {
      ok: true,
      value: { kind: "length", limit: raw === "max_tokens" ? "output" : "context" },
    };

  if (raw === "pause_turn") return { ok: true, value: { kind: "pause" } };

  if (raw === "refusal") return { ok: true, value: { kind: "refusal" } };

  return { ok: true, value: { kind: "other", raw } };
}
