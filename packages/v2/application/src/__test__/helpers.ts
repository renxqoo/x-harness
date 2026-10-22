import { defineService } from "../../../core/src/index";
import type { Result } from "../../../core/src/index";

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

export const ok = (): Result<void> => ({ ok: true, value: undefined });

export function service(name: string) {
  return value(
    defineService<{ read(input: void): Promise<Result<string>> }>({ name, methods: { read: {} } }),
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function flush() {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}
