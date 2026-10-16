import type { Continuation } from "../../contracts/types";
import { readData } from "../../contracts/read-data";

export interface Observation {
  actual: Promise<void>;
  settled: boolean;
  observed: boolean;
  failed: boolean;
}

export function createContinuation<T>(promise: Promise<T>, observations: Observation[]): Continuation<T> {
  const state: Observation = { actual: Promise.resolve(), settled: false, observed: false, failed: false };
  observations.push(state);
  state.actual = promise.then((value) => {
    state.settled = true;
    const data = readData(value);
    state.failed = data.ok && data.value.ok === false && "error" in data.value;
  }, () => { state.settled = true; state.failed = true; });
  const continuation: Continuation<T> = {
    then(fulfilled, rejected) {
      state.observed = true;
      return createContinuation(promise.then(fulfilled, rejected), observations);
    },
    catch(rejected) {
      state.observed = true;
      return createContinuation(promise.catch(rejected), observations);
    },
    finally(settled) {
      state.observed = true;
      return createContinuation(promise.finally(settled ?? undefined), observations);
    },
  };
  return Object.freeze(continuation);
}
