import { createHost } from "../../core/src/index";
import type { CloseReport, Result } from "../../core/src/index";
import { createFault, readData } from "../../core/src/validation";
import { planPlugins } from "./plan-plugins";
import { reconcilePlugins } from "./reconcile-plugins";
import { snapshotApplication } from "./snapshot-application";
import type { Application, ApplicationOptions, ApplicationSnapshot, ApplicationState } from "./types";

export function createApplication(options: ApplicationOptions = {}): Result<Application> {
  const read = readData(options);
  if (!read.ok || Object.keys(read.value).some((key) => !["host", "maxPlugins", "maxPendingOperations"].includes(key))) return createFault("invalid-input");
  const maxPlugins = read.value.maxPlugins ?? 128; const maxPending = read.value.maxPendingOperations ?? 32;
  if (![maxPlugins, maxPending].every((value) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 10000)) return createFault("invalid-input");
  const host = createHost(read.value.host as ApplicationOptions["host"]); if (!host.ok) return host;
  const state: ApplicationState = { host: host.value, wanted: { entries: [], providers: new Map() }, active: new Map(), failures: new Map() };
  let lifecycle: ApplicationSnapshot["state"] = "open"; let closing: Promise<Result<CloseReport>> | undefined;
  const queue: { run(): Promise<Result<ApplicationSnapshot>>; resolve(result: Result<ApplicationSnapshot>): void }[] = []; let running = false;
  const drain = async () => {
    if (running) return; running = true;
    while (queue.length) {
      const next = queue.shift()!;
      if (lifecycle !== "open") next.resolve(createFault("scope-closed"));
      else { try { next.resolve(await next.run()); } catch { next.resolve(createFault("callback-failed")); } }
    }
    running = false;
  };
  const enqueue = (run: () => Promise<Result<ApplicationSnapshot>>): Promise<Result<ApplicationSnapshot>> => {
    if (lifecycle !== "open") return Promise.resolve(createFault("scope-closed"));
    if (queue.length >= (maxPending as number)) return Promise.resolve(createFault("resource-limit"));
    return new Promise((resolve) => { queue.push({ run, resolve }); void drain(); });
  };
  const refresh = async (): Promise<Result<ApplicationSnapshot>> => {
    const result = await reconcilePlugins(state); if (!result.ok) return result;
    if (lifecycle !== "open") return createFault("scope-closed");
    return { ok: true, value: snapshotApplication(state, lifecycle) };
  };
  return { ok: true, value: Object.freeze({
    use: host.value.use, dispatch: host.value.dispatch, inspect: () => host.value.inspect(), diagnostics: () => host.value.diagnostics(),
    snapshot: () => snapshotApplication(state, lifecycle),
    setPlugins(plugins) {
      const plan = planPlugins(plugins, maxPlugins as number); if (!plan.ok) return Promise.resolve(plan);
      return enqueue(() => { state.wanted = plan.value; return refresh(); });
    },
    refresh: () => enqueue(refresh),
    close() {
      if (!closing) {
        lifecycle = "closing";
        closing = host.value.close().then((result) => {
          lifecycle = result.ok ? "closed" : "close-failed"; state.wanted = { entries: [], providers: new Map() }; state.active.clear(); state.failures.clear(); return result;
        });
      }
      return closing;
    },
  } satisfies Application) };
}
