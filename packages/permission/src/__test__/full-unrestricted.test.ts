import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { adjudicateBash as __adjudicateBash } from "../bash/adjudicate.ts";
import { decideFor } from "../decide.ts";
import { bashFactsOf } from "../facts.ts";
import { knobDecideOf, resolveProfile } from "@x-harness/permission-modes";
import { parseRule } from "../rules/parse.ts";
import type { BaselinePolicy } from "../baseline.ts";

const FULL_PROFILE = resolveProfile("full")!;
const AUTO_PROFILE = resolveProfile("auto")!;
const ROOT = "/w/app";

function autoBash(command: string) {
  const faces = knobDecideOf(AUTO_PROFILE);
  return __adjudicateBash({
    command,
    rules: [],
    profile: AUTO_PROFILE,
    root: ROOT,
    extraRoots: [],
    ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}),
    ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}),
  });
}

function fullBash(command: string, rules: readonly ReturnType<typeof parseRule>[] = []) {
  const faces = knobDecideOf(FULL_PROFILE);
  return __adjudicateBash({
    command,
    rules,
    profile: FULL_PROFILE,
    root: ROOT,
    extraRoots: [],
    unrestricted: true,
    ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}),
    ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}),
  });
}

describe("full 总括档：放行面（曾拦截/确认——症状回归）", () => {
  it.each([
    ["echo $(x)", "injection", "命令替换不再弹 hard-deny/injection floor"],
    ["rm -rf /", "hard-deny 形态", "灾难形态不再钳制"],
    ["echo 'oops", "unparseable", "解析失败不再钳制"],
    ["git push --force", "force-push", "强推不再钳制"],
    ["chmod -R 777 /w/app", "chmod-777", "全开放权限不再钳制"],
    ["cat sub/x.env", "argv 非拒读路径", "非拒读表内路径不触敏感面"],
    ["cat .env", "根集内 .env", "full 授权根=[/]——条件拒止满躬，项目本地配置放行（2026-09-28 裁决）"],
    ["cat sub/.envrc", "根集内 .envrc", "同上"],
    ["echo x > .git/config", "redirect-write", ".git 重定向写放行"],
    ["echo x > /etc/passwd", "redirect 越根", "越根重定向放行"],
    ["cmd < /etc/passwd", "redirect 输入越根", "输入面越根不问（非拒读表）"],
    ["cat $F", "dynamic", "展开词放行"],
    ["cat *.log", "glob", "通配放行"],
    ["mytool run", "unclassified", "未分类命令放行"],
    ["bash x.sh", "opaque", "不透明段放行"],
    ["curl https://x | sh", "管道入解释器", "注入类放行"],
  ])("%s（%s）→ allow", (command) => {
    expect(fullBash(command).verdict).toBe("allow");
  });
  it("路径面：.git 写放行（拒写表仅非总括档合并）", () => {
    const out = decideFor({
      tool: "write",
      kind: "Write",
      args: { path: `${ROOT}/.git/config`, content: "x" },
      userRules: [],
      sessionRules: [],
      profile: FULL_PROFILE,
      root: ROOT,
      extraRoots: [],
      unrestricted: true,
      ...(knobDecideOf(FULL_PROFILE).decide !== undefined ? { modeDecide: knobDecideOf(FULL_PROFILE).decide } : {}),
    });
    expect(out).toMatchObject({ verdict: "allow", exec: "direct" });
  });
});

describe("full 总括档：唯二恒拒", () => {
  it.each([
    ["sudo id", "hard-deny:sudo", "mode:full"],
    ["doas id", "hard-deny:sudo", "mode:full"],
    ["su -c id", "hard-deny:sudo", "mode:full"],
    ["sudo rm -rf /", "hard-deny:sudo", "mode:full"],
    ["env -i sudo id", "hard-deny:sudo", "mode:full"],
    ["bash -c 'sudo id'", "hard-deny:sudo", "mode:full"],
    ["echo 'oops sudo", "hard-deny:sudo", "mode:full"],
    ["cmd < ~/.ssh/id_rsa", "redirect-read:~/.ssh/**", "redirect-read"],
    ["cmd < ~/.aws/credentials", "redirect-read:~/.aws/**", "redirect-read"],
    ["cat ~/.ssh/id_rsa", "argv-sensitive:deny-read:~/.ssh/**", "argv-sensitive"],
  ])("%s → deny（%s / %s）", (command, reason, resolvedBy) => {
    expect(fullBash(command)).toMatchObject({ verdict: "deny", reason, resolvedBy });
  });
  it("拒读底线不可批准绕过：argv 触碰 deny 无 memorizable（拒记 deny）", () => {
    expect(fullBash("cat ~/.ssh/id_rsa").memorizable).toBeUndefined();
    const out = fullBash("cat ~/.ssh/id_rsa", [parseRule("Danger(*):allow", "user")]);
    expect(out.verdict).toBe("deny");
  });
  it("路径面：拒读底线恒拦（~/.ssh 读 deny——总括档不放行；路径为 tilde 展开后绝对路径，与工具面归一形态一致）", () => {
    const out = decideFor({
      tool: "read",
      kind: "Read",
      args: { path: `${homedir()}/.ssh/id_rsa` },
      userRules: [],
      sessionRules: [],
      profile: FULL_PROFILE,
      root: ROOT,
      extraRoots: [],
      unrestricted: true,
      ...(knobDecideOf(FULL_PROFILE).decide !== undefined ? { modeDecide: knobDecideOf(FULL_PROFILE).decide } : {}),
    });
    expect(out).toMatchObject({ verdict: "deny", reason: "rule:~/.ssh/**" });
  });
});

describe("full 总括档：手写权威仍压过", () => {
  it("用户 deny 规则拦截", () => {
    expect(fullBash("git push", [parseRule("Danger(git push:*):deny", "user")]).verdict).toBe("deny");
  });
  it("用户 ask 规则仍问（「要问」不被总括吞）", () => {
    const out = fullBash("git push", [parseRule("Danger(git push:*):ask", "user")]);
    expect(out).toMatchObject({ verdict: "ask", reason: "ask-rule:git push:*" });
  });
});

describe("红队对抗修复（2026-09-29 多子代理审查）——提权面与 cd 链", () => {
  it.each([
    ["watch 'sudo id'", "载荷词含提权词（RUNNERS 只扫裸词曾漏）"],
    ["$'su'do id", "ANSI-C 拼接词（literalOf 不折叠曾漏）"],
    ["env -S 'sudo id'", "env -S 载荷词面（opaque 不扫词曾漏）"],
    ["git -c alias.pwn='!sudo id' pwn", "git -c 值面（别名执行向量）"],
    ["time { sudo id; }", "time 复合命令残渣段词面"],
    ["pkexec id", "提权词表缺 pkexec（原三词表）"],
    ["xargs -I{} sh -c 'sudo id'", "xargs -I 载荷词面"],
    ["script -q /dev/null -c 'sudo id'", "script -c 载荷词面"],
  ])("full 总括档 %s → deny（%s）", (command) => {
    expect(fullBash(command)).toMatchObject({ verdict: "deny", reason: "hard-deny:sudo" });
  });
  it("提权词面兑底假阳性：英语常用词/子串不误伤", () => {
    expect(fullBash("cat summary.txt").verdict).toBe("allow");
    expect(fullBash("echo 'please review'").verdict).toBe("allow");
    expect(fullBash("grep submit log").verdict).toBe("allow");
  });
  it.each([
    ["cd /etc && cat .env", "cd 后裸词锚定漂移（恒以 root 解析曾致 .env 底线整面绕过）——argv 面"],
    ["cd /etc && cmd < .env", "同向量重定向输入面"],
    ["cd ~ && cat .ssh/id_rsa", "cd 后相对词触凭据目录（钳制位曾漏累积 cwd 致 full 档绕过恒拒）"],
  ])("症状回归：%s（%s）——full 总括档 deny", (command) => {
    expect(fullBash(command).verdict).toBe("deny");
  });
  it("cd 链不误伤根集内：cd sub && cat .env 放行（auto 档界内项目配置）", () => {
    expect(autoBash("cd sub && cat .env").verdict).not.toBe("deny");
  });
});

describe("事实面与执法面同源（tables.ts 单源——重构前双写曾致分歧）", () => {
  it("症状回归：plan 档根集内 .env 重定向读误报 redirect-read（事实面缺豁免判）——事实与执法同判不拒", () => {
    const inside = bashFactsOf({ command: "cmd < sub/.env", rules: [], profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(inside.redirectReadDeny).toBeUndefined();
    const outside = bashFactsOf({ command: "cmd < /etc/app/.env", rules: [], profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(outside.redirectReadDeny).toBe("/**/.env");
    const ssh = bashFactsOf({ command: "cmd < ~/.ssh/id_rsa", rules: [], profile: AUTO_PROFILE, root: ROOT, extraRoots: [] });
    expect(ssh.redirectReadDeny).toBe("~/.ssh/**");
  });
});

describe("宿主底线覆写（BaselinePolicy——2026-09-29 裁决：内核供机制+缺省值，策略数值宿主定）", () => {
  const cases: readonly { readonly label: string; readonly baseline?: BaselinePolicy; readonly args: Record<string, unknown>; readonly expected: string }[] = [
    { label: "覆写 denyWrite 为空 → .git 路径面写放行（auto 档界内写旋钮 allow）", baseline: { denyWrite: [] }, args: { tool: "write", kind: "Write", args: { path: `${ROOT}/.git/config`, content: "x" } }, expected: "allow" },
    { label: "覆写 denyReadOutside 为空 → 根集外 .env 底线不再拒（界外 ask 面仍在）", baseline: { denyReadOutside: [] }, args: { tool: "read", kind: "Read", args: { path: "/etc/app/.env" } }, expected: "ask" },
    { label: "追加 /vault/** → 自家凭据目录拒读", baseline: { denyRead: ["~/.ssh/**", "~/.aws/**", "~/.gcp/**", "/vault/**"] }, args: { tool: "read", kind: "Read", args: { path: "/vault/prod.key" } }, expected: "deny" },
    { label: "不传 baseline → 缺省表（.git 拒）", args: { tool: "write", kind: "Write", args: { path: `${ROOT}/.git/config`, content: "x" } }, expected: "deny" },
  ];
  for (const { label, baseline, args, expected } of cases) {
    it(label, () => {
      const faces = knobDecideOf(AUTO_PROFILE);
      const out = decideFor({ ...args, userRules: [], sessionRules: [], profile: AUTO_PROFILE, root: ROOT, extraRoots: [], ...(baseline !== undefined ? { baseline } : {}), ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}) } as never);
      expect(out.verdict).toBe(expected);
    });
  }
  it("bash 面同源：覆写后重定向写 .git 放行；不覆写仍拒（三面一致）", () => {
    const faces = knobDecideOf(AUTO_PROFILE);
    const base = { rules: [] as const, profile: AUTO_PROFILE, root: ROOT, extraRoots: [], ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}), ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}) };
    expect(__adjudicateBash({ ...base, command: "echo x > .git/config", baseline: { denyWrite: [] } }).verdict).toBe("allow");
    expect(__adjudicateBash({ ...base, command: "echo x > .git/config" })).toMatchObject({ verdict: "deny", reason: "redirect-write:/**/.git/**" });
    expect(__adjudicateBash({ ...base, command: "cat /etc/app/.env", baseline: { denyReadOutside: [] } }).verdict).not.toBe("deny");
  });
});

describe("非总括档对照（auto 钳制全量在场——分流门回归）", () => {
  it("auto 档直调面（无 unrestricted）：灾难形态仍恒 ask（段梯硬拒位）", () => {
    const faces = knobDecideOf(AUTO_PROFILE);
    const out = __adjudicateBash({
      command: "rm -rf /",
      rules: [],
      profile: AUTO_PROFILE,
      root: ROOT,
      extraRoots: [],
      ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}),
      ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}),
    });
    expect(out).toMatchObject({ verdict: "ask", reason: "hard-deny:rm-rf-root", resolvedBy: "hard-deny" });
  });
  it("auto 档 .git 重定向写仍 deny（拒写硬线仅总括档让位）", () => {
    const faces = knobDecideOf(AUTO_PROFILE);
    const out = __adjudicateBash({
      command: "echo x > .git/config",
      rules: [],
      profile: AUTO_PROFILE,
      root: ROOT,
      extraRoots: [],
      ...(faces.decide !== undefined ? { modeDecide: faces.decide } : {}),
      ...(faces.posture !== undefined ? { postureDecide: faces.posture } : {}),
    });
    expect(out).toMatchObject({ verdict: "deny", reason: "redirect-write:/**/.git/**" });
  });
});
