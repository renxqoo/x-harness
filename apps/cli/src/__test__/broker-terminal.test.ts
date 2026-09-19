// 终端审批 broker（docs/CLI.md §2.3）：decideApproval 词表闭集 + 交互/非交互两形态 +
// EOF（Ctrl+C 强制关闭）= deny。IO 注入，不碰真终端。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { permissionBroker } from "@x-harness/permission";
import type { AskRequest } from "@x-harness/permission";
import { createTerminalBrokerPlugin, decideApproval } from "../broker-terminal.ts";
import type { BrokerIO } from "../broker-terminal.ts";

const ASK: AskRequest = { tool: "bash", reason: "network fetch: api.example.com" };

describe("decideApproval（表驱动）", () => {
  const cases: readonly { readonly answer: string | undefined; readonly expected: "allow" | "deny" }[] = [
    { answer: "y", expected: "allow" },
    { answer: "Y", expected: "allow" },
    { answer: "yes", expected: "allow" },
    { answer: "YES", expected: "allow" },
    { answer: " y ", expected: "allow" },
    { answer: "n", expected: "deny" },
    { answer: "N", expected: "deny" },
    { answer: "", expected: "deny" },
    { answer: "nope", expected: "deny" },
    { answer: undefined, expected: "deny" },
  ];
  for (const testCase of cases) {
    it(`${JSON.stringify(testCase.answer)} → ${testCase.expected}`, () => {
      expect(decideApproval(testCase.answer)).toBe(testCase.expected);
    });
  }
});

function makeBroker(io: BrokerIO) {
  const ctx = createContext();
  void loadPlugins(ctx, [createTerminalBrokerPlugin(io)]);
  return ctx.use(permissionBroker);
}

describe("broker 形态", () => {
  it("交互：提示行含工具与理由；y → allow", async () => {
    const lines: string[] = [];
    const broker = makeBroker({ interactive: true, write: (line) => lines.push(line), question: () => Promise.resolve("y") });
    expect(await broker.ask(ASK)).toBe("allow");
    expect(lines[0]).toContain("allow bash?");
    expect(lines[0]).toContain("network fetch");
  });

  it("交互：n / EOF（接口被强制关闭）→ deny", async () => {
    const denied = makeBroker({ interactive: true, write: () => {}, question: () => Promise.resolve("n") });
    expect(await denied.ask(ASK)).toBe("deny");
    const eof = makeBroker({ interactive: true, write: () => {}, question: () => Promise.resolve(undefined) });
    expect(await eof.ask(ASK)).toBe("deny");
  });

  it("非交互（print 管道）：不提问，显式警告行 + deny", async () => {
    const lines: string[] = [];
    let questioned = false;
    const broker = makeBroker({
      interactive: false,
      write: (line) => lines.push(line),
      question: () => {
        questioned = true;
        return Promise.resolve("y");
      },
    });
    expect(await broker.ask(ASK)).toBe("deny");
    expect(questioned).toBe(false);
    expect(lines[0]).toContain("non-interactive");
    expect(lines[0]).toContain("bash");
  });
});
