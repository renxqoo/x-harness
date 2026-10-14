import { createFault } from "../contracts/create-fault";
import type { CoreFaultCode, Diagnostic, Result } from "../contracts/types";
import type { Owner, Runtime } from "../runtime/types";

export function reportDiagnostic(runtime: Runtime, code: CoreFaultCode, owner?: Owner): Result<never> {
  const diagnostic: Diagnostic = Object.freeze({
    id: `diagnostic-${runtime.nextId++}`, time: runtime.scheduler.now(), code,
    scopeId: owner?.scope.id ?? runtime.root.id, pluginName: owner?.name, message: code,
  });
  runtime.diagnostics.push(diagnostic);
  if (runtime.diagnostics.length > runtime.root.limits.maxDiagnostics) runtime.diagnostics.shift();
  try { runtime.diagnosticSink?.(diagnostic); } catch { }
  const fault = createFault(code);
  if (!fault.ok) return { ok: false, reason: { ...fault.reason, diagnosticId: diagnostic.id } };
  return fault;
}
