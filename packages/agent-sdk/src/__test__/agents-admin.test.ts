import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserAgentType, removeUserAgentType, renderAgentType } from "../commands/agents.ts";

describe("agents admin（用户类型 CRUD + 内置不可删）", () => {
  it("createUserAgentType 渲染→落盘→回读 round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-agents-"));
    try {
      const made = await createUserAgentType({ name: "reviewer", description: "reviews code", systemPrompt: "You review.", model: "GLM/glm-5.3-flash" }, undefined, root);
      expect(made.ok).toBe(true);
      const text = await readFile(join(root, "agents", "reviewer.md"), "utf8");
      expect(text).toContain("model: GLM/glm-5.3-flash");
      expect(text).toContain("You review.");
      const dup = await createUserAgentType({ name: "reviewer", description: "x", systemPrompt: "y" }, undefined, root);
      expect(dup.ok === false && dup.error.code).toBe("name_conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("createUserAgentType 校验族：空名/斜杠名/空描述/空提示词", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-agents-"));
    try {
      const badName = await createUserAgentType({ name: "a/b", description: "x", systemPrompt: "y" }, undefined, root);
      expect(badName.ok === false && badName.error.code).toBe("invalid_input");
      const noDesc = await createUserAgentType({ name: "ok", description: "", systemPrompt: "y" }, undefined, root);
      expect(noDesc.ok === false && noDesc.error.code).toBe("invalid_input");
      const noPrompt = await createUserAgentType({ name: "ok", description: "d", systemPrompt: "" }, undefined, root);
      expect(noPrompt.ok === false && noPrompt.error.code).toBe("invalid_input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removeUserAgentType：内置类型拒删（state_conflict），用户类型可删", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-agents-"));
    try {
      await createUserAgentType({ name: "mine", description: "d", systemPrompt: "p" }, undefined, root);
      const removed = await removeUserAgentType({ name: "mine", agentDir: root });
      expect(removed.ok).toBe(true);
      const builtin = await removeUserAgentType({ name: "general-purpose", agentDir: root, builtinTypes: [
        { stem: "general-purpose", text: "---\nname: general-purpose\ndescription: x\n---\nbody\n" },
      ] });
      expect(builtin.ok === false && builtin.error.code).toBe("state_conflict");
      const unknown = await removeUserAgentType({ name: "ghost", agentDir: root, builtinTypes: [] });
      expect(unknown.ok === false && unknown.error.code).toBe("state_conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renderAgentType 纯函数：字段行序与工具列表", () => {
    const out = renderAgentType({ name: "n", description: "d", systemPrompt: "p", tools: ["read", "grep"] });
    expect(out.ok && out.text.startsWith("---\nname: n\ndescription: d\ntools: read,grep\n---")).toBe(true);
  });
});
