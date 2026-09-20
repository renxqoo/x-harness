// --permission flag 装配旅程（docs/PERMISSION-MODE-FLAG.md 测试口径）：parseCliArgs →
// buildWorld → fenceKit → 真实 dispatch 管线的模式档行为锚。plan（write/bash 全拒）/
// full（许可放行 + 执法层两层语义快照——full 界外 PathGate 拒是登记挂账的现状行为）/
// deny 规则压过 mode / 缺省 auto 精确锚（resolvedBy 区分 auto 与 mode:full）/
// resume 不继承（mode 是装配事实非会话事实——plan 建档、无 flag 恢复即回 auto）。

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmRequest } from "@x-harness/llm";
import { permissionDecided } from "@x-harness/permission";
import type { ModeKnob, PermissionAudit } from "@x-harness/permission";
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
  readonly permission?: ModeKnob;
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

describe("--permission full 装配旅程", () => {
  it("write 界内放行（mode:full）且真写出文件", async () => {
    const j = await makeJourney({ permission: "full" });
    const out = await j.dispatch("write", { path: "made.txt", content: "FULL-MADE" });
    expect(out.isError).not.toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "mode:full", reason: "full mode", session: j.session });
    await expect(readFile(join(j.root, "made.txt"), "utf8")).resolves.toBe("FULL-MADE");
  });

  it("write 界外：许可层 allow（mode:full）+ 执法层 PATH_ESCAPES_ROOT——full 档两层语义现状快照（挂账锚）", async () => {
    // extraRoots 唯一来源是 ask 批准落账的 grants，full 绕过 ask → gate 无授权根 → 界外拒
    const j = await makeJourney({ permission: "full" });
    const outside = join(tmpdir(), "xh-permflag-outside", "f.txt");
    const out = await j.dispatch("write", { path: outside, content: "x" });
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining("PATH_ESCAPES_ROOT") });
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "mode:full", reason: "full mode", session: j.session });
  });

  it("deny 规则压过 full：.git 内写仍拒（rule 压过 mode 档的安全底线）", async () => {
    const j = await makeJourney({ permission: "full" });
    const out = await j.dispatch("write", { path: ".git/config", content: "x" });
    expect(out.isError).toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "rule:user", reason: "rule:**/.git/**", session: j.session });
  });
});

describe("缺省 auto 精确锚", () => {
  it("不带 permission：界内 allow resolvedBy auto（与 mode:full 精确区分）+ 界外 ask→broker deny（锁缺省非 full）", async () => {
    const j = await makeJourney();
    const inside = await j.dispatch("write", { path: "in.txt", content: "x" });
    expect(inside.isError).not.toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "auto", reason: "in-root", session: j.session });
    const outside = join(tmpdir(), "xh-permflag-outside", "g.txt");
    const blocked = await j.dispatch("write", { path: outside, content: "x" });
    expect(blocked.isError).toBe(true);
    expect(j.audits).toContainEqual({ tool: "write", verdict: "deny", resolvedBy: "outside-root", reason: expect.stringContaining("outside-root:"), session: j.session });
  });
});

describe("resume 不继承 mode（mode 是装配事实非会话事实）", () => {
  it("plan 建档 → 无 flag 恢复即回 auto：界内 write 放行（方案「不处理」表行为锚）", async () => {
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
    expect(second.audits).toContainEqual({ tool: "write", verdict: "allow", resolvedBy: "auto", reason: "in-root", session: id });
  });
});
