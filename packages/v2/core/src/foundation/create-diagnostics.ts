import { createFault } from "../contracts/create-fault";
import { definitionData } from "../contracts/definition-data";
import { readJsonValue } from "../contracts/read-json-value";
import type { Diagnostic, JsonValue, Scheduler } from "../contracts/types";
import type { Kernel, Scope } from "./types";

export function createDiagnostics(
  root: Scope,
  scheduler: Scheduler,
  options: { id: () => number; sink?: (diagnostic: Diagnostic) => void },
) {
  const diagnostics: Diagnostic[] = [];
  let reporting = false;

  const report: Kernel["fault"] = (code, owner, context) => {
    const definition = context?.definition && definitionData.get(context.definition)?.token;
    let raw: JsonValue | undefined = context?.details;

    if (definition)
      raw = {
        definition: `${definition.kind}/${definition.name}`,
        ...(raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.fromEntries(Object.entries(raw))
          : {}),
      };

    const parsed = raw === undefined ? undefined : readJsonValue(raw);
    const details = parsed?.ok ? parsed.value : undefined;
    let time = 0;

    try {
      const now = scheduler.now();

      if (Number.isFinite(now)) time = now;
    } catch {}

    const location = {
      scopeId: context?.scopeId ?? owner?.scope.id ?? root.id,
      ...(owner?.name ? { pluginName: owner.name } : {}),
      ...(context?.callId ? { callId: context.callId } : {}),
    };
    const diagnostic: Diagnostic = Object.freeze({
      id: `diagnostic-${options.id()}`,
      time,
      code,
      ...location,
      message: code,
      ...(details !== undefined ? { details } : {}),
    });
    diagnostics.push(diagnostic);

    if (diagnostics.length > root.limits.maxDiagnostics) diagnostics.shift();

    if (!reporting) {
      reporting = true;

      try {
        options.sink?.(diagnostic);
      } catch {}

      reporting = false;
    }

    const fault = createFault(code);
    return {
      ok: false,
      error: Object.freeze({
        ...fault.error,
        ...location,
        diagnosticId: diagnostic.id,
        ...(details !== undefined ? { details } : {}),
      }),
    };
  };

  return Object.freeze({ snapshot: () => Object.freeze([...diagnostics]), report });
}
