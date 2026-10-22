import type { Result } from "../../core/src/index";
import type { ApplicationSnapshot } from "../../application/src/index";
import type { LoaderFault } from "./types";
import { loaderFault } from "./loader-fault";
type RefreshResult = Result<ApplicationSnapshot, LoaderFault>;
interface Options {
  readonly run: () => Promise<RefreshResult>;
  readonly blocked: () => "closed" | "restart-required" | undefined;
  readonly debounceMs: number;
  readonly watch: boolean;
}
interface State {
  readonly options: Options;
  dirty: boolean;
  revalidate: boolean;
  running?: Promise<RefreshResult>;
  timer?: ReturnType<typeof setTimeout>;
  retryTimer: boolean;
  failures: number;
  watchFailed: boolean;
  recoverable: boolean;
}

export function createRefresh(options: Options) {
  const cell: { current?: State } = {
    current: {
      options,
      dirty: false,
      revalidate: false,
      retryTimer: false,
      failures: 0,
      watchFailed: false,
      recoverable: true,
    },
  };
  return {
    changed() {
      const state = cell.current;

      if (!state || state.options.blocked()) return;

      state.dirty = true;

      if (!state.running) arm(cell, state, false);
    },
    revalidate() {
      const state = cell.current;

      if (!state || state.options.blocked()) return;

      state.revalidate = true;

      if (!state.running) arm(cell, state, false);
    },
    failed() {
      const state = cell.current;

      if (!state || !state.options.watch || state.options.blocked()) return;

      state.watchFailed = true;

      if (!state.running && state.recoverable) arm(cell, state, true);
    },
    reload(this: void) {
      return reload(cell);
    },
    async close() {
      const state = cell.current;
      cell.current = undefined;

      if (!state) return;

      if (state.timer !== undefined) clearTimeout(state.timer);

      await state.running;
    },
  };
}

function arm(cell: { current?: State }, state: State, retry: boolean) {
  if (cell.current !== state || state.options.blocked()) return;

  if (state.timer !== undefined) {
    if (retry || !state.retryTimer) return;

    clearTimeout(state.timer);
  }

  state.retryTimer = retry;
  const delay = retry
    ? Math.max(state.options.debounceMs, Math.min(1000, 100 * 2 ** Math.min(state.failures++, 4)))
    : state.options.debounceMs;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void reload(cell);
  }, delay);
}

function reload(cell: { current?: State }): Promise<RefreshResult> {
  const state = cell.current;

  if (!state) return Promise.resolve(loaderFault("closed"));

  const blocked = state.options.blocked();

  if (blocked) return Promise.resolve(loaderFault(blocked));

  if (state.timer !== undefined) clearTimeout(state.timer);

  state.timer = undefined;
  state.dirty = true;

  if (state.running) return state.running;

  let last: RefreshResult | undefined;
  state.running = Promise.resolve()
    .then(async () => {
      const blocked = state.options.blocked();

      if (cell.current !== state || blocked) return loaderFault(blocked ?? "closed");

      do {
        state.dirty = false;
        state.revalidate = false;
        state.watchFailed = false;

        try {
          last = await state.options.run();
        } catch {
          last = loaderFault("restart-required");
        }
      } while (
        (state.dirty || (state.revalidate && last.ok)) &&
        cell.current === state &&
        !state.options.blocked()
      );

      return last;
    })
    .finally(() => {
      state.running = undefined;

      if (cell.current !== state || state.options.blocked()) return;

      state.recoverable = canRecover(last);

      if (last?.ok && !state.watchFailed) state.failures = 0;

      if (state.dirty || (state.revalidate && last?.ok)) arm(cell, state, false);
      else if (
        state.options.watch &&
        state.recoverable &&
        (state.watchFailed || (last && !last.ok))
      )
        arm(cell, state, true);
    });
  return state.running;
}

function canRecover(result: RefreshResult | undefined) {
  if (!result) return false;

  if (result.ok) return true;

  return (
    result.error.source === "loader" &&
    (result.error.code === "build-failed" || result.error.code === "watch-failed")
  );
}
