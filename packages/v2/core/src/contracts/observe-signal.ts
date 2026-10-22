const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!;
const add = Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener")!;
const remove = Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener")!;

export function signalAborted(signal: AbortSignal): boolean {
  return aborted.get!.call(signal) as boolean;
}

export function observeSignal(signal: AbortSignal, callback: () => void): () => void {
  Reflect.apply(add.value as (...args: unknown[]) => void, signal, [
    "abort",
    callback,
    { once: true },
  ]);

  return () => {
    Reflect.apply(remove.value as (...args: unknown[]) => void, signal, ["abort", callback]);
  };
}
