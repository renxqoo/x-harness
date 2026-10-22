import { definePlugin } from "../../../../core/src/index";
import type { Plugin, ServiceToken } from "../../../../core/src/index";
import { readData } from "../../../../core/src/validation";
import type {
  LlmProviderService,
  ProviderStreamInput,
  ProviderEnd,
  LlmLimits,
  ModelDescription,
  LlmResult,
} from "../contracts";
import { readLlmLimits } from "../domain/read-limits";
import { readLlmRequest } from "../domain/read-request";
import { readModelDescription } from "../domain/read-description";
import { readProviderEnd } from "../domain/read-end";
import { createLlmControl } from "../domain/create-control";
import type { LlmControl } from "../domain/create-control";
import { keys, text } from "../domain/read-values";
import { fail } from "../domain/fail";
import { createProviderSink } from "../stream/create-provider-sink";
export interface ProviderPluginOptions {
  readonly token: ServiceToken<LlmProviderService>;
  readonly models: Readonly<Record<string, ModelDescription>>;
  readonly limits?: Partial<LlmLimits>;
  readonly run: (
    input: ProviderStreamInput,
    context: {
      readonly limits: LlmLimits;
      readonly control: LlmControl;
      readonly model: ModelDescription;
    },
  ) => Promise<LlmResult<ProviderEnd>>;
}

export function createLlmProviderPlugin(raw: ProviderPluginOptions): LlmResult<Plugin> {
  const read = readData(raw);

  if (
    !read.ok ||
    !keys(read.value, ["token", "models", "limits", "run"]) ||
    typeof read.value.run !== "function"
  )
    return fail("invalid-input");

  const options = read.value as unknown as ProviderPluginOptions;
  const limits = readLlmLimits(options.limits, true);
  const models = readData(options.models);

  if (!limits.ok) return limits;

  const token = readData(options.token);

  if (!token.ok || token.value.kind !== "service" || !text(token.value.name, 128))
    return fail("invalid-input");

  if (!models.ok || !Object.keys(models.value).length || Object.keys(models.value).length > 1024)
    return fail("invalid-input");

  const descriptions = new Map<string, ModelDescription>();

  for (const [name, raw] of Object.entries(models.value)) {
    const model = readModelDescription(raw);

    if (!text(name) || !model.ok || model.value.model !== name) return fail("invalid-input");

    descriptions.set(name, model.value);
  }

  return {
    ok: true,
    value: definePlugin({
      name: `llm-provider/${token.value.name as string}`,
      provides: { provider: options.token },
      setup(ctx) {
        let active = 0;
        return ctx.service({
          provider: {
            async describe(raw) {
              const input = readData(raw);

              if (!input.ok || !keys(input.value, ["model", "signal"]) || !text(input.value.model))
                return fail("invalid-input");

              const value = descriptions.get(input.value.model);
              return value ? { ok: true, value } : fail("unsupported-feature");
            },
            async stream(raw, call) {
              const data = readData(raw);

              if (
                !data.ok ||
                !keys(data.value, ["request", "provider", "signal", "onEvent"]) ||
                typeof data.value.onEvent !== "function" ||
                !text(data.value.provider, 128)
              )
                return fail("invalid-input");

              const request = readLlmRequest(data.value.request, limits.value);

              if (!request.ok) return request;

              const model = descriptions.get(request.value.model);

              if (!model) return fail("unsupported-feature");

              if (active >= limits.value.maxActiveRequests)
                return fail("busy", { phase: "admission" });

              let control: LlmControl;

              try {
                control = createLlmControl({
                  signals: [call.signal, data.value.signal as AbortSignal, request.value.signal],
                  timeoutMs: request.value.timeoutMs ?? limits.value.timeoutMs,
                });
              } catch {
                return fail("invalid-input");
              }

              if (control.error()) {
                control.close();
                return { ok: false, error: control.error()! };
              }

              active++;
              const sink = createProviderSink(data.value.onEvent as ProviderStreamInput["onEvent"]);

              try {
                const result = await options.run(
                  {
                    request: request.value,
                    provider: data.value.provider,
                    signal: control.signal,
                    onEvent: sink.onEvent,
                  },
                  { limits: limits.value, control, model },
                );
                const delivered = await sink.finish();

                if (!delivered.ok) return delivered;

                if (control.error()) return { ok: false, error: control.error()! };

                return result.ok ? readProviderEnd(result.value) : result;
              } catch {
                return control.error()
                  ? { ok: false, error: control.error()! }
                  : fail("provider-error", { phase: "stream" });
              } finally {
                await sink.finish();
                control.close();
                active--;
              }
            },
          },
        });
      },
    }),
  };
}
