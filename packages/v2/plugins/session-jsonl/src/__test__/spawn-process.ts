import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

export function child(input: { path: string; entry?: string; mode: string; commitId?: string }) {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let exited = false;
  const process = Bun.spawn(
    [
      Bun.which("bun")!,
      resolve(dirname(fileURLToPath(import.meta.url)), "jsonl-process.ts"),
      input.entry ?? resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts"),
      input.path,
      input.mode,
      input.commitId ?? "once",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      ipc(message) {
        messages.push(message as Record<string, unknown>);

        for (const notify of listeners) notify();
      },
    },
  );
  const errors = new Response(process.stderr).text();
  const output = new Response(process.stdout).text();
  void process.exited.then(() => {
    exited = true;

    for (const notify of listeners) notify();
  });
  return {
    process,
    wait(phase: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Process timeout ${phase}`));
        }, 10000);

        const check = () => {
          const found = messages.find((item) => item.phase === phase);

          if (found) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(found);
          } else if (exited) {
            clearTimeout(timer);
            listeners.delete(check);
            void Promise.all([errors, output]).then(([err, out]) =>
              reject(new Error(`${err}${out}`)),
            );
          }
        };

        listeners.add(check);
        check();
      });
    },
    async close() {
      if (!exited) process.kill("SIGKILL");

      await process.exited;
      await Promise.all([errors, output]);
    },
  };
}
