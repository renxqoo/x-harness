import { definePlugin } from "../../../core/src/index";
import type { Plugin, TokenMap } from "../../../core/src/index";
import type { ToolInputSchema, ToolPluginOptions, ToolsResult } from "./contracts/types";
import { toolCatalog, toolDispatch, toolPreparation } from "./contracts";
import { data, keys, name } from "./domain/read-values";
import { readLimits } from "./domain/read-limits";
import { compileDescription } from "./schema/compile-description";
import { fail } from "./domain/fail";
import { encodePluginName } from "./domain/encode-plugin-name";
import { extendInvocation } from "./execution/extend-invocation";

export function createToolPlugin<
  const S extends ToolInputSchema,
  const D extends TokenMap = Record<never, never>,
  const O extends TokenMap = Record<never, never>,
>(raw: ToolPluginOptions<S, D, O>): ToolsResult<Plugin> {
  const d = data(raw);

  if (
    !d ||
    !keys(d, [
      "name",
      "description",
      "inputSchema",
      "outputSchema",
      "requires",
      "optional",
      "concurrency",
      "limits",
      "prepare",
      "execute",
    ]) ||
    !name(d.name) ||
    typeof d.execute !== "function" ||
    (d.prepare !== undefined && typeof d.prepare !== "function") ||
    (d.description !== undefined &&
      (typeof d.description !== "string" || d.description.length > 8192))
  )
    return fail("invalid-input");

  const requires = data(d.requires ?? {}),
    optional = data(d.optional ?? {});

  if (
    !requires ||
    !optional ||
    Object.keys({ ...requires, ...optional }).some((k) =>
      ["toolCatalog", "toolDispatch", "toolPreparation"].includes(k),
    )
  )
    return fail("invalid-input");

  const concurrency = d.concurrency ?? 1;

  if (
    !Number.isSafeInteger(concurrency) ||
    (concurrency as number) < 1 ||
    (concurrency as number) > 256
  )
    return fail("invalid-input");

  const description = compileDescription({
    name: d.name,
    concurrency,
    inputSchema: d.inputSchema,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.outputSchema !== undefined ? { outputSchema: d.outputSchema } : {}),
  });

  if (!description.ok) return description;

  const limits = readLimits(d.limits, true);

  if (!limits.ok) return limits;

  const configured = Object.freeze(data(d.limits ?? {})!);
  const prepare = d.prepare as typeof raw.prepare,
    execute = d.execute as typeof raw.execute;
  return {
    ok: true,
    value: definePlugin({
      name: encodePluginName("tool", d.name),
      requires: {
        ...(requires as Record<never, never>),
        toolCatalog,
        toolDispatch,
        toolPreparation,
      },
      optional: optional as Record<never, never>,
      setup(ctx) {
        const entry = Object.freeze({
          signal: ctx.signal,
          tool: description.value.tool,
          limits: configured,
        });
        const catalog = ctx.middleware("toolCatalog", (query, next) => {
          const sent = query.visit(entry);
          return sent.ok ? next(query) : sent;
        });

        if (!catalog.ok) return catalog;

        const preparation = ctx.middleware("toolPreparation", (request, next, call) => {
          if (request.ownerSignal !== ctx.signal || request.name !== entry.tool.name)
            return next(request);

          if (!prepare) return { ok: true, value: {} };

          return prepare(
            request.input as never,
            extendInvocation(call, {
              callId: request.callId,
              name: request.name,
              caller: request.caller,
            }) as never,
          );
        });

        if (!preparation.ok) return preparation;

        return ctx.middleware("toolDispatch", (request, next, call) => {
          if (request.ownerSignal !== ctx.signal || request.name !== entry.tool.name)
            return next(request);

          return execute(
            request.input as never,
            extendInvocation(call, {
              callId: request.callId,
              name: request.name,
              caller: request.caller,
              plan: request.plan,
              progress: request.progress,
              ...(request.execution ? { execution: request.execution } : {}),
            }) as never,
          );
        });
      },
    }),
  };
}
