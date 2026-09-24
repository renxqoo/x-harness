// probeBaseFacts（宿主环境探测——fs IO 边）：isGit 祖先上寻（worktree file 形态算）、
// shell 缺席降级、date 已迁快照通道不在 facts。

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
      writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n"); // worktree file 形态
      mkdirSync(join(root, "sub"));
      const facts = probeBaseFacts({ cwd: join(root, "sub"), platform: "darwin", env: { SHELL: "/bin/zsh\n" } });
      expect(facts.isGit).toBe(true); // 自 sub 上寻命中
      expect(facts.shell).toBe("/bin/zsh"); // 换行被入口归一压掉
      expect("date" in facts).toBe(false); // 日期已迁快照通道（TAIL-SNAPSHOT-CHANNEL）
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
