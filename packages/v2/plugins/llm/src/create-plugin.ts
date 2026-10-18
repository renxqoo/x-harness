import { definePlugin } from "../../../core/src/index";
import type { Plugin, PluginInvocation } from "../../../core/src/index";
import { readData } from "../../../core/src/validation";
import type { LlmOptions, LlmResult, ProviderMap, LlmRunInput, LlmRunOutput, LlmStreamInput } from "./contracts";
import { llm, llmRequest } from "./contracts";
import { readLlmLimits } from "./domain/read-limits";
import { readLlmRequest } from "./domain/read-request";
import { createSchemaCache } from "./domain/create-schema-cache";
import { readModelDescription } from "./domain/read-description";
import { keys, text } from "./domain/read-values";
import { fail } from "./domain/fail";
import { runModel } from "./stream/run-model";
type ProviderKey = `provider_${number}`;
type BoundProviders = Readonly<Record<ProviderKey, ProviderMap[string]>>;
type Manifest = { readonly requires: BoundProviders; readonly provides: { readonly llm: typeof llm; readonly request: typeof llmRequest } };
export function createLlmPlugin(raw: LlmOptions): LlmResult<Plugin> {
  const input = readData(raw); if (!input.ok || !keys(input.value, ["providers", "defaultProvider", "limits"])) return fail("invalid-input"); const limits = readLlmLimits(input.value.limits); if (!limits.ok) return limits; const providers = readData(input.value.providers); if (!providers.ok || !Object.keys(providers.value).length || Object.keys(providers.value).length > limits.value.maxProviders) return fail("invalid-input");
  const routes = new Map<string, ProviderKey>(); const requires: Record<ProviderKey, ProviderMap[string]> = Object.create(null); const bindings = new Map<ProviderMap[string], ProviderKey>();
  for (const [name, token] of Object.entries(providers.value)) { const data = readData(token); if (!text(name, 128) || !data.ok || data.value.kind !== "service" || !text(data.value.name, 160)) return fail("invalid-input"); const service = token as ProviderMap[string]; let key = bindings.get(service); if (!key) { key = `provider_${bindings.size}`; bindings.set(service, key); requires[key] = service; } routes.set(name, key); }
  const defaultProvider = input.value.defaultProvider; if (defaultProvider !== undefined && (typeof defaultProvider !== "string" || !routes.has(defaultProvider))) return fail("invalid-input");
  return { ok: true, value: definePlugin({ name: "llm", requires, provides: { llm, request: llmRequest }, setup(ctx) {
    let active = 0; const schemas = createSchemaCache(); const cleanup = ctx.addCleanup(() => { schemas.close(); return { ok: true, value: undefined }; }); if (!cleanup.ok) return cleanup;
    const execute = async (raw: unknown, call: PluginInvocation<Manifest>): Promise<LlmResult<LlmRunOutput>> => {
      const read = readData(raw); if (!read.ok || !keys(read.value, ["request", "onEvent", "collect"]) || typeof read.value.onEvent !== "function" || typeof read.value.collect !== "boolean") return fail("invalid-input"); const input = read.value as unknown as LlmRunInput; const request = readLlmRequest(input.request, limits.value); if (!request.ok) return request; const provider = request.value.provider ?? defaultProvider; const key = typeof provider === "string" ? routes.get(provider) : undefined; if (!key || typeof provider !== "string") return fail("provider-not-found"); if (active >= limits.value.maxActiveRequests) return fail("busy", { phase: "admission" }); active++;
      const task = call.spawn({ label: "llm-stream", run(child) { return runModel({ input: { ...input, request: request.value }, provider, service: child.deps[key]!, signal: child.signal, limits: limits.value, schemas }); } }); if (!task.ok) { active--; return task; }
      try { return await call.wait(task.value); } finally { await task.value.finished; active--; }
    };
    const terminal = ctx.handle("request", execute); if (!terminal.ok) return terminal;
    const invoke = async (raw: unknown, collect: boolean, call: PluginInvocation<Manifest>): Promise<LlmResult<LlmRunOutput>> => {
      const data = readData(raw); if (!data.ok || (!collect && typeof data.value.onEvent !== "function")) return fail("invalid-input"); const request = readLlmRequest(raw, limits.value); if (!request.ok) return request;
      const result=await call.dispatch("request", { request: request.value, collect, onEvent: collect ? () => {} : data.value.onEvent as LlmStreamInput["onEvent"] }, {signal:request.value.signal,timeoutMs:request.value.timeoutMs??limits.value.timeoutMs});
      if(!result.ok&&result.error.source==="core"&&(result.error.code==="cancelled"||result.error.code==="timeout"))call.cancel(result.error.code);
      return result;
    };
    return ctx.service({ llm: {
      async stream(input, call) { const result = await invoke(input, false, call); return result.ok ? { ok: true, value: result.value.summary } : result; },
      async generate(input, call) { const result = await invoke(input, true, call); if (!result.ok) return result; if (!result.value.content) return fail("protocol-error", { phase: "output" }); return { ok: true, value: Object.freeze({ ...result.value.summary, content: result.value.content, ...(result.value.output !== undefined ? { output: result.value.output } : {}) }) }; },
      async describe(raw, call) { const read = readData(raw); if (!read.ok || !keys(read.value, ["model", "provider"]) || !text(read.value.model)) return fail("invalid-input"); const provider = read.value.provider ?? defaultProvider; const key = typeof provider === "string" ? routes.get(provider) : undefined; if (!key) return fail("provider-not-found"); const result = await call.deps[key]!.describe({ model: read.value.model }); if (!result.ok) return result; const model = readModelDescription(result.value); return model.ok && model.value.model === read.value.model ? model : fail("protocol-error"); },
    } });
  } }) };
}
