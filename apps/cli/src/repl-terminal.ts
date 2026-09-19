// REPL 终端（docs/CLI.md §2.3 stdin 单所有权）：单一 readline 实例封装——
// 行订阅、提问（question 先 pause 主 prompt，未决集可被强制收束）、强制关闭
// （挂起提问 resolve undefined → broker deny 路径）、EOF=退出。
// Ctrl+C 的业务语义（cancel/双击退出）归 run-repl，本文件只透传 SIGINT 事件。

import readline from "node:readline";
import { Writable } from "node:stream";

export interface ReplTerminalIO {
  readonly stdin: NodeJS.ReadableStream;
  /** readline echo/prompt 的写出面（含用户输入回显） */
  readonly write: (text: string) => void;
}

export interface ReplTerminal {
  onLine(callback: (line: string) => void): void;
  onQuit(callback: () => void): void;
  onInterrupt(callback: () => void): void;
  /** 提问：主 prompt 暂停 → question → 恢复；接口已关/被强制关闭 → undefined */
  question(prompt: string): Promise<string | undefined>;
  /** 强制关闭（退出路径）：挂起中的 question 立即 resolve undefined */
  close(): void;
  /** 只收束挂起中的提问（Ctrl+C ask 路径 → broker deny）；无挂起返回 false */
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
    // EOF（Ctrl+D / 管道关闭）或 close() 已先行收束——只广播一次
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
      return true;
    },
    showPrompt: () => {
      if (!closed) rl.prompt(true);
    },
  };
}
