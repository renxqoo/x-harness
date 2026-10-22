import { observeSignal, signalAborted } from "../contracts/observe-signal";

const idle = () => {};

export function createCancellationObserver() {
  const signals = new WeakMap<AbortSignal, Set<() => void>>();

  return (signal: AbortSignal, callback: () => void): (() => void) => {
    if (signalAborted(signal)) return idle;

    let callbacks = signals.get(signal);

    if (!callbacks) {
      callbacks = new Set();
      observeSignal(signal, notify(signals, signal, callbacks));
      signals.set(signal, callbacks);
    }

    callbacks.add(callback);
    let active = true;

    return () => {
      if (!active) return;

      active = false;
      callbacks.delete(callback);
    };
  };
}

function notify(
  signals: WeakMap<AbortSignal, Set<() => void>>,
  signal: AbortSignal,
  callbacks: Set<() => void>,
) {
  return () => {
    signals.delete(signal);

    for (const callback of Array.from(callbacks)) {
      if (!callbacks.delete(callback)) continue;

      try {
        callback();
      } catch {}
    }

    callbacks.clear();
  };
}
