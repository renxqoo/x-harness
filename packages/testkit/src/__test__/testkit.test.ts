// testkit 三用例（SDK-MIGRATION-F3 §3）：剧本形态/捕获与回落参数化/假工具计数。

import { describe, expect, it } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import { fakeTool, scriptedAdapter, textScript } from "../index.ts";

async function drain(stream: AsyncIterable<LlmChunk>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.type === "text-delta" ? chunk.text : "";
  return out;
}

describe("testkit", () => {
  it("textScript：单条文本 + stop 收束", async () => {
    expect(await drain(textScript("hello"))).toBe("hello");
  });

  it("scriptedAdapter：calls 捕获 + 剧本弹出 + 耗尽回落（文本/函数双形态）", async () => {
    const calls: unknown[] = [];
    const adapter = scriptedAdapter({ calls: calls as never, scripts: [textScript("first")] });
    expect(await drain(adapter.stream({ model: "m" } as never))).toBe("first");
    expect(await drain(adapter.stream({ model: "m" } as never))).toBe("(no script)"); // 缺省回落
    expect(calls).toHaveLength(2);
    const custom = scriptedAdapter({ scripts: [], exhausted: (req) => textScript(`exhausted:${String(req.model)}`) });
    expect(await drain(custom.stream({ model: "z" } as never))).toBe("exhausted:z"); // 参数化回落
  });

  it("fakeTool：空 schema 执行 + 计数", async () => {
    let count = 0;
    const tool = fakeTool("note", () => { count += 1; return { content: `noted-${String(count)}` }; });
    const r = await tool.execute({}, { callId: "c1", name: "note", signal: new AbortController().signal });
    expect(r.content).toBe("noted-1");
    expect(count).toBe(1);
  });
});
