import { describe, expect, it } from "vitest";
import { adjudicateBash as __adjudicateBash } from "../bash/adjudicate.ts";
import { knobDecideOf } from "@x-harness/permission-modes";
function adjudicateBash(input: Parameters<typeof __adjudicateBash>[0]): ReturnType<typeof __adjudicateBash> {
  const faces = knobDecideOf(input.profile);
  return __adjudicateBash({ ...input, ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}) });
}
import { decideFor as __decideFor } from "../decide.ts";
function decideFor(input: Parameters<typeof __decideFor>[0]): ReturnType<typeof __decideFor> {
  const faces = knobDecideOf(input.profile);
  const family = (["read","write","edit","grep","bash"] as const).includes(input.tool as never) ? ({ read: "Read", write: "Write", edit: "Write", grep: "Read", bash: "Danger" } as const)[input.tool as "read" | "write" | "edit" | "grep" | "bash"] : undefined;
  return __decideFor({ ...input, ...(input.kind === undefined && family !== undefined ? { kind: family } : {}), ...(input.modeDecide === undefined && faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(input.postureDecide === undefined && faces.posture !== undefined ? { postureDecide: faces.posture } : {}) });
}
import { protectGlobMatch } from "../sensitive.ts";
import { parseRule } from "../rules/parse.ts";
import { resolveProfile } from "@x-harness/permission-modes";

const PLAN = resolveProfile("plan")!;
const AUTO = resolveProfile("auto")!;
const ROOT = "/w/app";
const rules = (texts: readonly string[] = []) => texts.map((t) => parseRule(t, "user"));
const base = (profile = AUTO, texts: readonly string[] = []) => {
  const list = rules(texts);
  return { rules: list, userRules: list, sessionRules: [], profile, root: ROOT, extraRoots: [] };
};

describe("B-bug-1：plan 档读保护基线（不因研究通道豁免）", () => {
  it("plan 档敏感面读 → deny（auto 档为 ask）——严格缺省全拒覆盖；富策略细分断言在 tool-plan/plan-mode.test", () => {
    expect(adjudicateBash({ ...base(PLAN), command: "cat ~/.ssh/id_rsa" })).toMatchObject({ verdict: "deny", reason: "plan mode disallows bash" });
    expect(adjudicateBash({ ...base(PLAN), command: "cat < ~/.ssh/id_rsa" }).verdict).toBe("deny");
    expect(adjudicateBash({ ...base(AUTO), command: "cat ~/.ssh/id_rsa" }).verdict).toBe("ask");
  });
});

describe("B-bug-5：plan 档 dynamic 段过滤（classifyPipeline 前置条件执法）", () => {
  it("plan 档展开/通配词 → deny（不再静默进分类器误判 readonly）", () => {
    expect(adjudicateBash({ ...base(PLAN), command: "cat $F" })).toMatchObject({ verdict: "deny", reason: "plan mode disallows bash" });
  });
});

describe("B-bug-2：写安全动词界内校验的越根操作数", () => {
  it("裸 .. 与附着值旗目标 → 逐出写类（unclassified → ask，不再 in-root-write 直通）", () => {
    for (const command of ["mv secret ..", "cp -t .. f", "mkdir ..", "cp --target-directory=/etc secret"]) {
      const out = adjudicateBash({ ...base(AUTO), command });
      expect(out.verdict, command).toBe("ask");
      expect(out.reason, command).not.toContain("in-root-write");
    }
  });
});

describe("B-bug-3：rg --pre 执行钩子", () => {
  it("rg --pre COMMAND → 逐出只读（auto ask / plan deny）；无 --pre 照常 readonly", () => {
    expect(adjudicateBash({ ...base(AUTO), command: "rg --pre /bin/sh pattern file" }).verdict).toBe("ask");
    expect(adjudicateBash({ ...base(PLAN), command: "rg --pre /bin/sh pattern file" }).verdict).toBe("deny");
    expect(adjudicateBash({ ...base(AUTO), command: "rg -n pattern file" }).resolvedBy).toBe("classifier:readonly");
  });
});

describe("P-bug-1：路径面/Tool 面手写 ask 规则", () => {
  it("Write(src/**):ask → 界内写 ask（ask-rule 归因，不再被 in-root 放行吞掉）；Tool(x):ask 同理", () => {
    const withAsk = base(AUTO, ["Write(src/**):ask", "Tool(mystery):ask"]);
    const write = decideFor({ ...withAsk, tool: "write", args: { path: "src/a.ts", content: "x" } });
    expect(write).toMatchObject({ verdict: "ask", reason: "ask-rule:src/**" });
    const mystery = decideFor({ ...withAsk, tool: "mystery", args: {} });
    expect(mystery).toMatchObject({ verdict: "ask", reason: "ask-rule:mystery" });
    expect(decideFor({ ...base(AUTO), tool: "write", args: { path: "src/a.ts", content: "x" } }).verdict).toBe("allow");
  });
});

describe("P-bug-5：保护面目录感知匹配", () => {
  it("裸目录 pattern 命中嵌套文件；已有通配不受影响", () => {
    expect(protectGlobMatch("/u/.x-harness/plugins", "/u/.x-harness/plugins/evil.sh", ROOT)).toBe(true);
    expect(protectGlobMatch("/u/.x-harness/plugins", "/u/.x-harness/plugins", ROOT)).toBe(true);
    expect(protectGlobMatch("/u/.x-harness/plugins", "/u/.x-harness/other.sh", ROOT)).toBe(false);
    expect(protectGlobMatch("/w/**", "/w/a/b.ts", ROOT)).toBe(true);
  });
});

describe("D1 对抗审查回归：词面提权兜底仅在解析失败面", () => {
  it("可解析命令原文含 sudo/su → 不误判提权（full/plan 放行 readonly；真提权仍拒）", () => {
    expect(adjudicateBash({ ...base(AUTO), command: "grep sudo README.md" }).resolvedBy).toBe("classifier:readonly");
    expect(adjudicateBash({ ...base(PLAN), command: "git log --grep=sudo" }).verdict).toBe("deny");
    expect(adjudicateBash({ ...base(AUTO), command: "echo su" }).verdict).toBe("allow");
    expect(adjudicateBash({ ...base(AUTO), command: "sudo ls" }).verdict).toBe("ask");
    expect(adjudicateBash({ ...base(AUTO), command: "echo \x27sudo oops" }).verdict).toBe("ask");
  });
});
