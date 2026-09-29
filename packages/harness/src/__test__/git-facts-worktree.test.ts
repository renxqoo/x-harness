import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { probeGitFacts } from "@x-harness/harness";
const exec = promisify(execFile);
describe("切错分支疑点实证", () => {

let root: string;
const setup = async () => {
  root = mkdtempSync(join(tmpdir(), "xh-wb-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await exec("git", ["-C", repo, "init"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "F"), "x");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-m", "s"]);
  await exec("git", ["-C", repo, "branch", "dev"]);
  await exec("git", ["-C", repo, "worktree", "add", join(root, "wt"), "dev"]);
  return realpathSync(repo);
};

it("① 手建 worktree 内直接探测：显示 dev 不显示 main", async () => {
  const repo = await setup();
  expect(probeGitFacts(repo).branch).toBe("main" in {} ? "" : (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim());
  expect(probeGitFacts(join(root, "wt")).branch).toBe("dev");
});

it("② worktree 内切分支 → 现算跟随（下一轮询即新值）", async () => {
  await setup();
  const wt = join(root, "wt");
  expect(probeGitFacts(wt).branch).toBe("dev");
  await exec("git", ["-C", wt, "checkout", "-b", "hot/switched"]);
  expect(probeGitFacts(wt).branch).toBe("hot/switched");
});

it("③ 主仓切分支不影响 worktree 行（各读各的 HEAD）", async () => {
  const repo = await setup();
  await exec("git", ["-C", repo, "checkout", "-b", "main-side-branch"]);
  expect(probeGitFacts(join(root, "wt")).branch).toBe("dev");
  await exec("git", ["-C", repo, "checkout", "-b", "another/main-side"]);
  expect(probeGitFacts(join(root, "wt")).branch).toBe("dev");
});

it("④ worktree 被删 → 键省略（不回退显示主仓分支）", async () => {
  await setup();
  await exec("git", ["-C", join(root, "repo"), "worktree", "remove", "--force", join(root, "wt")]);
  expect(probeGitFacts(join(root, "wt"))).toEqual({});
});
});
