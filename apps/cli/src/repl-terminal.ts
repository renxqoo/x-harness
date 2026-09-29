import readline from "node:readline";
import { Writable } from "node:stream";

export interface ReplTerminalIO {
  readonly stdin: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
}

export interface ReplTerminal {
  onLine(callback: (line: string) => void): void;
  onQuit(callback: () => void): void;
  onInterrupt(callback: () => void): void;
  question(prompt: string): Promise<string | undefined>;
  close(): void;
  cancelPendingQuestion(): boolean;
  showPrompt(): void;
}

export function createReplTerminal(io: ReplTerminalIO): ReplTerminal {
  const output = new Writable({
    write: (chunk, _encoding, callback) => {
      io.write(chunk.toString("utf8"));
      callback();
    },
  });
  const rl = readline.createInterface({ input: io.stdin, output, prompt: "> " });
  let lineCallback: ((line: string) => void) | undefined;
  let quitCallback: (() => void) | undefined;
  let interruptCallback: (() => void) | undefined;
  const pending = new Set<(answer: string | undefined) => void>();
  let closed = false;

  rl.on("line", (line: string) => {
    lineCallback?.(line);
  });
  rl.on("close", () => {
    if (closed) return;
    closed = true;
    quitCallback?.();
  });
  rl.on("SIGINT", () => {
    interruptCallback?.();
  });

  return {
    onLine: (callback) => {
      lineCallback = callback;
    },
    onQuit: (callback) => {
      quitCallback = callback;
    },
    onInterrupt: (callback) => {
      interruptCallback = callback;
    },
    question: (prompt) =>
      new Promise<string | undefined>((resolve) => {
        if (closed) {
          resolve(undefined);
          return;
        }
        pending.add(resolve);
        rl.pause();
        rl.question(prompt, (answer) => {
          pending.delete(resolve);
          if (!closed) {
            rl.resume();
            rl.prompt(true);
          }
          resolve(answer);
        });
      }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const resolve of pending) resolve(undefined);
      pending.clear();
      rl.close();
      io.write("\n");
    },
    cancelPendingQuestion: () => {
      if (pending.size === 0) return false;
      for (const resolve of pending) resolve(undefined);
      pending.clear();
      if (!closed) {
        rl.resume();
        rl.write("\n");
      }
      return true;
    },
    showPrompt: () => {
      if (!closed) rl.prompt(true);
    },
  };
}
