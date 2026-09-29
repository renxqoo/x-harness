import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeBaseFacts } from "../base-prompt-probe.ts";

describe("probeBaseFacts（宿主探测）", () => {
  it("isGit 祖先上寻（worktree file 形态算）；shell 换行归一；date 已迁快照通道不在 facts", () => {
    const root = mkdtempSync(join(tmpdir(), "xh-facts-"));
    try {
      expect(probeBaseFacts({ cwd: root, platform: "darwin", env: {} }).isGit).toBe(false);
      writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
      mkdirSync(join(root, "sub"));
      const facts = probeBaseFacts({ cwd: join(root, "sub"), platform: "darwin", env: { SHELL: "/bin/zsh\n" } });
      expect(facts.isGit).toBe(true);
      expect(facts.shell).toBe("/bin/zsh");
      expect("date" in facts).toBe(false);
      expect(facts.cwd).toBe(join(root, "sub"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("env.SHELL 缺席 → unknown（垃圾降级，绝不空值）", () => {
    const facts = probeBaseFacts({ cwd: "/w", platform: "linux", env: {} });
    expect(facts.shell).toBe("unknown");
  });
});
