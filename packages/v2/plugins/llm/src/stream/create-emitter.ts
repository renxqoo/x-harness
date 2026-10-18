import type { LlmEventBody, LlmEvent, LlmResult, LlmLimits } from "../contracts";
import type { LlmControl } from "../domain/create-control";
import { fail } from "../domain/fail";
export function createEmitter(input: { readonly requestId: string; readonly onEvent: (event: LlmEvent, signal: AbortSignal) => void | Promise<void>; readonly control: LlmControl; readonly limits: LlmLimits }) {
  let sequence = 0; let bytes = 0; let sending = false; let closed = false; let broken = false; let hasOutput = false;
  return {
    async emit(body: LlmEventBody): Promise<LlmResult<void>> {
      if (closed || broken || sending) return fail("protocol-error", { phase: "consumer" }); const event = Object.freeze({ ...body, requestId: input.requestId, sequence }) as LlmEvent; const size = new TextEncoder().encode(JSON.stringify(event)).length;
      const terminal = ["error", "finish"].includes(body.type); const reserve = Math.min(8192, Math.floor(input.limits.maxOutputBytes / 4));
      if (size > input.limits.maxEventBytes || (sequence >= input.limits.maxEvents - Number(!terminal)) || bytes + size > input.limits.maxOutputBytes - (terminal ? 0 : reserve)) return fail("capacity-exceeded", { phase: "stream" }); bytes += size; sequence++; sending = true;
      if (body.type === "tool-call" || body.type === "continuation" || body.type === "citation" || (body.type === "provider-event" && body.scope === "block") || ("delta" in body && body.delta.length > 0)) hasOutput = true;
      try { const result = await input.control.step("consumer", input.limits.consumerTimeoutMs, async () => { await input.onEvent(event, input.control.signal); return { ok: true, value: undefined }; }); if (!result.ok) broken = true; if (body.type === "error" || body.type === "finish") closed = true; return result; }
      finally { sending = false; }
    },
    hasOutput: () => hasOutput,
    usable: () => !closed && !broken && !sending,
    close() { closed = true; },
  };
}
