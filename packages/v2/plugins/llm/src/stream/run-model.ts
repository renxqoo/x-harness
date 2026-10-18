import type { LlmLimits, LlmProviderService, LlmRunInput, LlmRunOutput, LlmResult, LlmError, ProviderEvent } from "../contracts";
import type { SchemaCache } from "../domain/create-schema-cache";
import { readLlmRequest } from "../domain/read-request";
import { readModelDescription } from "../domain/read-description";
import { checkCapabilities } from "../domain/check-capabilities";
import { createLlmControl } from "../domain/create-control";
import { fail } from "../domain/fail";
import { createStreamState } from "./create-state";
import { advanceStream } from "./advance-state";
import { finishStream } from "./finish-stream";
import { createEmitter } from "./create-emitter";
import { createProviderSink } from "./create-provider-sink";
let nextRequest = 0;
export async function runModel(args: { readonly input: LlmRunInput; readonly provider: string; readonly service: LlmProviderService; readonly signal: AbortSignal; readonly limits: LlmLimits; readonly schemas: SchemaCache }): Promise<LlmResult<LlmRunOutput>> {
  const request = readLlmRequest(args.input.request, args.limits); if (!request.ok) return request;
  const control = createLlmControl({ signals: [args.signal, request.value.signal], timeoutMs: request.value.timeoutMs ?? args.limits.timeoutMs });
  let emitter: ReturnType<typeof createEmitter> | undefined; let sink: ReturnType<typeof createProviderSink> | undefined; let state: ReturnType<typeof createStreamState> | undefined;
  const enrich = (error: LlmError): LlmError => Object.freeze({ ...error, hasOutput: emitter?.hasOutput() ?? false });
  const failure = async (result: LlmResult<never>): Promise<LlmResult<never>> => {
    if (result.ok || result.error.source !== "llm") return result; const error = enrich(result.error);
    if (emitter?.usable() && !control.signal.aborted) { const sent = await emitter.emit({ type: "error", error }); if (!sent.ok) return sent.error.source === "llm" ? { ok: false, error: enrich(sent.error) } : sent; }
    return { ok: false, error };
  };
  try {
    const described = await control.step("admission", request.value.timeoutMs ?? args.limits.timeoutMs, () => args.service.describe({ model: request.value.model, signal: control.signal })); if (!described.ok) return described; const model = readModelDescription(described.value); if (!model.ok || model.value.model !== request.value.model) return fail("protocol-error"); const admitted = checkCapabilities(request.value, model.value, args.provider); if (!admitted.ok) return admitted;
    for (const schema of [...(request.value.tools?.map((tool) => tool.inputSchema) ?? []), ...(request.value.output?.type === "json-schema" ? [request.value.output.schema] : [])]) { const compiled = args.schemas.compile(schema); if (!compiled.ok) return compiled; }
    emitter = createEmitter({ requestId: `llm-${++nextRequest}`, onEvent: args.input.onEvent, control, limits: args.limits }); state = createStreamState({ request: request.value, provider: args.provider, protocol: model.value.protocol, canonicalModel: model.value.canonicalModel, limits: args.limits, collect: args.input.collect });
    sink = createProviderSink(async (raw: ProviderEvent) => { const events = advanceStream(state!, raw); if (!events.ok) return events; for (const event of events.value) { const sent = await emitter!.emit(event); if (!sent.ok) return sent; } return { ok: true, value: undefined }; });
    if (control.error()) return { ok: false, error: control.error()! }; const started = await emitter.emit({ type: "start", provider: args.provider, model: request.value.model }); if (!started.ok) return started;
    let result = await args.service.stream({ request: request.value, provider: args.provider, signal: control.signal, onEvent: sink.onEvent }); const delivered = await sink.finish(); if (!delivered.ok) result = delivered; if (control.error()) result = { ok: false, error: control.error()! }; if (!result.ok) return await failure(result);
    const finished = finishStream(state, result.value, args.schemas); if (!finished.ok) return await failure(finished);
    for (const event of finished.value.events) { const sent = await emitter.emit(event); if (!sent.ok) return await failure(sent); } const sent = await emitter.emit({ type: "finish", summary: finished.value.result.summary }); return sent.ok ? { ok: true, value: finished.value.result } : await failure(sent);
  } catch { return await failure(fail("provider-error", { phase: "stream" })); }
  finally { await sink?.finish(); emitter?.close(); control.close(); }
}
