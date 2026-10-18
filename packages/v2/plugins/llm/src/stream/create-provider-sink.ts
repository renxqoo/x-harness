import type { ProviderEvent, LlmResult } from "../contracts";
import { fail } from "../domain/fail";
interface Cell { handler?: (event: ProviderEvent) => Promise<LlmResult<void>>; pending?: Promise<LlmResult<void>>; failure?: LlmResult<never>; violated: boolean }
export function createProviderSink(handler: (event: ProviderEvent) => Promise<LlmResult<void>>) {
  const cell: Cell = { handler, violated: false };
  return {
    onEvent: callback(cell),
    async finish(): Promise<LlmResult<void>> { if (cell.pending) { cell.violated = true; await cell.pending; } cell.handler = undefined; return cell.failure ?? (cell.violated ? fail("protocol-error", { phase: "stream" }) : { ok: true, value: undefined }); },
  };
}
function callback(cell: Cell): (event: ProviderEvent) => Promise<LlmResult<void>> {
  return (event) => {
    if (!cell.handler) return Promise.resolve(fail("closed", { phase: "stream" })); if (cell.failure) return Promise.resolve(cell.failure);
    if (cell.pending) { cell.violated = true; return Promise.resolve(fail("protocol-error", { phase: "stream" })); }
    const handler = cell.handler; const pending = Promise.resolve().then(() => handler(event)).then((result) => { if (!result.ok) cell.failure ??= result; return result; }, () => { const result = fail("protocol-error", { phase: "stream" }); cell.failure ??= result; return result; }).finally(() => { cell.pending = undefined; }); cell.pending = pending; return pending;
  };
}
