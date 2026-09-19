// AgentOptions 合成（docs/CLI.md §2.1/§2.6 表驱动）：工具白/黑名单矩阵 + create/resume
// 两层 dial + 系统提示词静态串形态。

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../parse-cli-args.ts";
import { agentOptionsForCreate, agentOptionsForResume, resolveToolNames } from "../resolve-agent-options.ts";

const REGISTERED = ["read", "write", "bash", "grep", "task_output", "task_stop"];

function args(argv: string[]) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

describe("resolveToolNames（表驱动）", () => {
  const cases: readonly { readonly name: string; readonly argv: string[]; readonly expected: readonly string[] }[] = [
    { name: "缺省 = 全部注册工具", argv: [], expected: REGISTERED },
    { name: "--no-tools = 全禁", argv: ["--no-tools"], expected: [] },
    { name: "--tools 白名单", argv: ["--tools", "read,grep"], expected: ["read", "grep"] },
    { name: "--exclude-tools 从全集减", argv: ["--exclude-tools", "bash,write"], expected: ["read", "grep", "task_output", "task_stop"] },
    { name: "--tools + --exclude-tools 白后减", argv: ["--tools", "read,write,bash", "--exclude-tools", "write"], expected: ["read", "bash"] },
    { name: "--tools 含未注册名（发送面无此 schema，如实保留）", argv: ["--tools", "read,nope"], expected: ["read", "nope"] },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveToolNames(args(testCase.argv), REGISTERED)).toEqual(testCase.expected);
    });
  }
});

describe("agentOptionsForCreate", () => {
  it("dial = defaults 全量（provider/model/thinking）+ 工具投影", () => {
    const options = agentOptionsForCreate(args([]), { provider: "glm", model: "glm-4.7", thinking: "low" }, REGISTERED);
    expect(options).toEqual({ provider: "glm", model: "glm-4.7", thinking: "low", tools: REGISTERED });
  });

  it("thinking 缺席不发；--system-prompt 走静态串", () => {
    const options = agentOptionsForCreate(args(["--system-prompt", "CUSTOM"]), { provider: "glm", model: "m" }, REGISTERED);
    expect(options.thinking).toBeUndefined();
    expect(options.systemPrompt).toBe("CUSTOM");
  });
});

describe("agentOptionsForResume", () => {
  it("仅显式 flag 进 options；未给处 undefined（回落会话末次 dial/header）", () => {
    const options = agentOptionsForResume(args([]), {}, REGISTERED);
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.tools).toBeUndefined(); // 无工具 flag 不传——避免放开上一会话受限名单
  });

  it("overrides 成对下传（--model 唯一命中带 provider）", () => {
    const options = agentOptionsForResume(args(["--thinking", "high"]), { provider: "ovt", model: "qwen3", thinking: "high" }, REGISTERED);
    expect(options).toEqual({ provider: "ovt", model: "qwen3", thinking: "high" });
  });

  it("显式 --thinking off 保留（foldDial 显式恒胜会话末次等级）", () => {
    const options = agentOptionsForResume(args(["--thinking", "off"]), { thinking: "off" }, REGISTERED);
    expect(options.thinking).toBe("off");
  });

  it("工具 flag 在场时 resume 同样收窄", () => {
    const options = agentOptionsForResume(args(["--tools", "read"]), {}, REGISTERED);
    expect(options.tools).toEqual(["read"]);
  });
});
