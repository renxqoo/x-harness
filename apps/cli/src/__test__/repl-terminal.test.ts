// repl-terminal（docs/CLI.md §2.3 stdin 单所有权）：提问/强制关闭收束未决提问/EOF 退出/
// 行订阅。PassThrough 驱动，不碰真终端。

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createReplTerminal } from "../repl-terminal.ts";

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function makeTerminal() {
  const stdin = new PassThrough();
  const output: string[] = [];
  const terminal = createReplTerminal({ stdin, write: (text) => output.push(text) });
  return { stdin, output, terminal };
}

describe("createReplTerminal", () => {
  it("行订阅：写入一行回调一行", async () => {
    const { stdin, terminal } = makeTerminal();
    const lines: string[] = [];
    terminal.onLine((line) => lines.push(line));
    stdin.write("one\n");
    stdin.write("two\n");
    await delay(20);
    expect(lines).toEqual(["one", "two"]);
  });

  it("question：resolve 答案且 prompt 展示", async () => {
    const { stdin, output, terminal } = makeTerminal();
    const asked = terminal.question("[y/N] ");
    stdin.write("y\n");
    expect(await asked).toBe("y");
    expect(output.join("")).toContain("[y/N]");
  });

  it("强制关闭：挂起中的 question 立即 resolve undefined（Ctrl+C ask → deny 路径）", async () => {
    const { stdin, terminal } = makeTerminal();
    const asked = terminal.question("[y/N] ");
    await delay(10);
    terminal.close();
    expect(await asked).toBeUndefined();
    stdin.end();
  });

  it("已关闭后 question 直接 undefined；重复 close 幂等", async () => {
    const { terminal } = makeTerminal();
    terminal.close();
    terminal.close();
    expect(await terminal.question("x")).toBeUndefined();
  });

  it("EOF（stdin end）触发 onQuit 恰一次", async () => {
    const { stdin, terminal } = makeTerminal();
    let quits = 0;
    terminal.onQuit(() => {
      quits += 1;
    });
    stdin.end();
    await delay(20);
    expect(quits).toBe(1);
  });
});
