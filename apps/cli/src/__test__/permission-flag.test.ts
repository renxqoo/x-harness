// --permission flag 装配旅程（docs/PERMISSION-MODE-FLAG.md 测试口径）：parseCliArgs →
// buildWorld → fenceKit → 真实 dispatch 管线的模式档行为锚。plan（write/bash 全拒）/
// full（总括授权三面铺开——界外真可达，docs/PERMISSION-FULL-UNRESTRICTED.md）/
// deny 规则压过 mode / 缺省 auto 精确锚（resolvedBy 区分 auto 与 mode:full）/
// resume 不继承（mode 是装配事实非会话事实——plan/full 建档、无 flag 恢复即回 auto）。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmRequest } from "@x-harness/llm";
import { permissionDecided } from "@x-harness/permission";
import type { ProfileId, PermissionAudit } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import type { ToolOutcome } from "@x-harness/tools";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

// 旅程不跑 LLM turn——adapter 只为五服务装配在场，被调即测试装置错误
const NULL_ADAPTER: LlmAdapter = {
  name: "glm",
  stream: (_request: LlmRequest) => {
    throw new Error("permission journey does not stream");
  },
};

// 非交互 broker（print 形态语义）：ask 恒 deny
const BROKER = createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) });

interface Journey {
  readonly world: World;
  readonly root: string;
  readonly audits: PermissionAudit[];
  readonly session: SessionId;
  dispatch(name: string, args: unknown): Promise<ToolOutcome>;
}

interface JourneyOptions {
  readonly permission?: ProfileId;
  readonly persist?: boolean;
  readonly sessionRoot?: string;
}

const roots: string[] = [];
const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.ctx.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makeJourney(options: JourneyOptions = {}): Promise<Journey> {
  const root = await mkdtemp(join(tmpdir(), "xh-permflag-"));
  roots.push(root);
  const sessionRoot = options.sessionRoot ?? join(root, "sessions");
  const built = await buildWorld({
    cwd: root,
    sessionRoot,
    persist: options.persist === true,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    ...(options.permission !== undefined ? { permission: options.permission } : {}),
    broker: BROKER,
    adapters: [NULL_ADAPTER],
  });
  if (!built.ok) throw new Error(`buildWorld failed: ${built.reason}`);
  const world = built.value;
  worlds.push(world);
  const audits: PermissionAudit[] = [];
  world.ctx.on(permissionDecided, (audit) => audits.push(audit));
  const made = await world.loop.create({ agent: { model: "m1" } });
  if (!made.ok) throw new Error(made.reason);
  const session = made.value.agent.session.id;
  let callSeq = 0;
  return {
    world,
    root,
    audits,
    session,
    dispatch: (name, args) =>
      world.registry.dispatch({ callId: `permflag-${String(callSeq += 1)}`, name, args, signal: new AbortController().signal, session }),
  };
}

describe("--permission plan 装配旅程", () => {
  it("write 界内拒（mode:plan）——denied 文案回传模型", async () => {
    const j = await makeJourney({ permission: "plan" });
    const out = await j.dispatch("write", { path: "new.txt", content: "x" });
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining("denied:permission:plan mode disallows write") });
    expect(j.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "mode:plan", reason: "plan mode disallows write", session: j.session });
  });

  it("bash 全拒（mode:plan）——plan 不被 bash 写文件绕过（首次入锚）", async () => {
    const j = await makeJourney({ permission: "plan" });
    const out = await j.dispatch("bash", { command: "echo hi" });
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining("denied:permission:plan mode disallows bash") });
    expect(j.audits).toContainEqual({ tool: "bash", verdict: "deny", resolvedBy: "mode:plan", reason: "plan mode disallows bash", session: j.session });
  });
});

describe("--permission full 装配旅程（总括授权——docs/PERMISSION-FULL-UNRESTRICTED.md）", () => {
  it("write 界内放行（mode:full）且真写出文件", async () => {
    const j = await makeJourney({ permission: "full" });
    const out = await j.dispatch("write", { path: "made.txt", content: "FULL-MADE" });
    expect(out.isError).not.toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "mode:full", reason: "full mode", exec: "direct", session: j.session });
    await expect(readFile(join(j.root, "made.txt"), "utf8")).resolves.toBe("FULL-MADE");
  });

  it("write 界外真写出：授权根 / 经既有管道流入 PathGate（许可与执法两层一致）", async () => {
    const j = await makeJourney({ permission: "full" });
    const outsideDir = await mkdtemp(join(tmpdir(), "xh-permflag-full-"));
    roots.push(outsideDir); // mkdtemp 每次新建并登记清理——防 FS_NOT_OBSERVED 二次运行 flake
    const target = join(outsideDir, "f.txt");
    const out = await j.dispatch("write", { path: target, content: "OUTSIDE-FULL" });
    expect(out.isError).not.toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "mode:full", reason: "full mode", exec: "direct", session: j.session });
    await expect(readFile(target, "utf8")).resolves.toBe("OUTSIDE-FULL");
  });

  it("read/grep 界外真读到真搜到（授权根 / + 剖面 sysctl-read 窄许可——完整功能锚）", async () => {
    const j = await makeJourney({ permission: "full" });
    const outsideDir = await mkdtemp(join(tmpdir(), "xh-permflag-fr-"));
    roots.push(outsideDir);
    const target = join(outsideDir, "note.txt");
    await writeFile(target, "GREP-TARGET-LINE\n", "utf8");
    const read = await j.dispatch("read", { path: target });
    expect(read.isError).not.toBe(true);
    expect(read.content).toContain("GREP-TARGET-LINE");
    const grep = await j.dispatch("grep", { pattern: "GREP-TARGET", path: outsideDir });
    expect(j.audits).toContainEqual({ tool: "grep", verdict: "allow", resolvedBy: "mode:full", reason: "full mode", exec: "direct", session: j.session });
    expect(grep.isError).not.toBe(true); // 剖面缺 sysctl-read 时的症状：SEARCH_FAILED rg SIGABRT
    expect(grep.content).toContain("GREP-TARGET-LINE");
  });

  it("deny 规则压过 full：.git 内写仍拒（rule 压过 mode 档的安全底线）", async () => {
    const j = await makeJourney({ permission: "full" });
    const out = await j.dispatch("write", { path: ".git/config", content: "x" });
    expect(out.isError).toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "rule:user", reason: "rule:**/.git/**", session: j.session });
  });
});

describe("缺省 sandboxed-auto 精确锚（U6——CLI 围栏优先）", () => {
  it("不带 permission：界内 allow resolvedBy auto + exec contained（与 mode:full 的 direct 精确区分）+ 界外 ask→broker deny", async () => {
    const j = await makeJourney();
    const inside = await j.dispatch("write", { path: "in.txt", content: "x" });
    expect(inside.isError).not.toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "auto", reason: "in-root", exec: "contained", session: j.session });
    const outside = join(tmpdir(), "xh-permflag-outside", "g.txt");
    const blocked = await j.dispatch("write", { path: outside, content: "x" });
    expect(blocked.isError).toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "outside-root", reason: expect.stringContaining("outside-root:"), session: j.session });
  });
});

describe("resume 不继承 mode（mode 是装配事实非会话事实）", () => {
  it("plan 建档 → 无 flag 恢复即回缺省 sandboxed-auto：界内 write 放行（档位是装配事实非会话事实）", async () => {
    const sessionRoot = join(tmpdir(), `xh-permflag-resume-${String(Date.now())}`);
    roots.push(sessionRoot);
    const first = await makeJourney({ permission: "plan", persist: true, sessionRoot });
    const denied = await first.dispatch("write", { path: "new.txt", content: "x" });
    expect(denied.isError).toBe(true);
    const id = first.session;
    await first.world.ctx.dispose().catch(() => {});
    worlds.splice(worlds.indexOf(first.world), 1);

    const second = await makeJourney({ persist: true, sessionRoot });
    const resumed = await second.world.loop.resume({ id, agent: { model: "m1" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.reason);
    let callSeq = 0;
    const dispatch = (name: string, args: unknown): Promise<ToolOutcome> =>
      second.world.registry.dispatch({ callId: `permflag-r-${String(callSeq += 1)}`, name, args, signal: new AbortController().signal, session: id });
    const allowed = await dispatch("write", { path: "after-resume.txt", content: "x" });
    expect(allowed.isError).not.toBe(true);
    expect(second.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "auto", reason: "in-root", exec: "contained", session: id });
  });

  it("full 建档 → 无 flag 恢复即回 auto：总括不落会话档，界外 write 回归 ask→deny 链", async () => {
    const sessionRoot = join(tmpdir(), `xh-permflag-resume-full-${String(Date.now())}`);
    roots.push(sessionRoot);
    const outsideDir = await mkdtemp(join(tmpdir(), "xh-permflag-rf-"));
    roots.push(outsideDir);
    const target = join(outsideDir, "f.txt");
    const first = await makeJourney({ permission: "full", persist: true, sessionRoot });
    const written = await first.dispatch("write", { path: target, content: "x" });
    expect(written.isError).not.toBe(true); // full 总括下界外真写出
    await expect(readFile(target, "utf8")).resolves.toBe("x");
    const id = first.session;
    await first.world.ctx.dispose().catch(() => {});
    worlds.splice(worlds.indexOf(first.world), 1);

    const second = await makeJourney({ persist: true, sessionRoot }); // 不带 flag——auto
    const resumed = await second.world.loop.resume({ id, agent: { model: "m1" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.reason);
    rmSync(target, { force: true }); // 清掉首程文件——auto 档若放行会重写成功
    const blocked = await second.world.registry.dispatch({ callId: "permflag-rf-2", name: "write", args: { path: target, content: "y" }, signal: new AbortController().signal, session: id });
    expect(blocked.isError).toBe(true); // 回到 ask→broker deny（非总括直接放行）
    expect(second.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "outside-root", reason: expect.stringContaining("outside-root:"), session: id });
  });
});
