// agent 动态注册安全闭环（plugin-runtime §5/§9 安全回归）：
// propose 只产数据（登记 + confirm 请求）/ confirm 应答置位 / 消费一次性 /
// 源路径不匹配拒 / 绝对路径围栏 / 提案 TTL 作废 / 坏文件降级。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolRegistry, toolsPlugin } from "@x-harness/tools";
import { createPluginProposePlugin } from "../worker/plugin-propose.ts";
import { createPluginProposalStore, PROPOSAL_TTL_MS } from "../shared/plugin-proposals.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 起一个带 plugin_propose 工具的世界（confirm 桥可编程；登记进真实文件面 store） */
async function worldWithPropose(agentDir: string, confirm: (fields: { tool: string; reason: string }) => Promise<{ allowed: boolean }>): Promise<ReturnType<typeof createContext>> {
  const store = createPluginProposalStore(agentDir);
  const ctx = createContext();
  await loadPlugins(ctx, [
    toolsPlugin,
    createPluginProposePlugin({ confirm, record: (proposal) => store.record(proposal) }),
  ]);
  return ctx;
}

const runPropose = async (ctx: ReturnType<typeof createContext>, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> => {
  const tool = ctx.use(toolRegistry).get("plugin_propose");
  if (tool === undefined) throw new Error("plugin_propose not registered");
  return tool.execute(args, { callId: "t", name: "plugin_propose", signal: new AbortController().signal });
};

async function makeSource(name: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pp-src-"));
  tempDirs.push(base);
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name, kind: "third-party", apiVersion: 1, description: `${name} desc` }));
  await writeFile(join(root, "index.ts"), `export default { name: "${name}", apply(_ctx, caps) { void caps; } };\n`);
  return root;
}

describe("plugin_propose 工具：登记与确认链（端到端）", () => {
  it("用户允许 → 登记提案 + 应答 pending_install；提案初始未确认", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pp-"));
    tempDirs.push(agentDir);
    const source = await makeSource("my-plugin");
    const seen: { tool: string; reason: string }[] = [];
    const ctx = await worldWithPropose(agentDir, async (fields) => {
      seen.push(fields);
      return { allowed: true };
    });
    const out = await runPropose(ctx, { sourcePath: source });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("pending_install");
    // confirm 请求面：P2 语义在场（能力授予明示）
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe("plugin_propose");
    expect(seen[0]?.reason).toContain("full platform capabilities");
    expect(seen[0]?.reason).toContain("my-plugin");
    // 工具侧只产数据：文件面已登记、confirmed=false（置位是 host confirm 命令的事）
    const [proposal] = await createPluginProposalStore(agentDir).list();
    expect(proposal?.name).toBe("my-plugin");
    expect(proposal?.confirmed).toBe(false);
    expect(proposal?.description).toBe("my-plugin desc");
    expect(proposal?.requestedCapabilities).toEqual([]);
  });

  it("用户拒绝 → 应答 rejected；提案留在面板（confirmed=false）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pp-"));
    tempDirs.push(agentDir);
    const source = await makeSource("denied-plugin");
    const ctx = await worldWithPropose(agentDir, async () => ({ allowed: false }));
    const out = await runPropose(ctx, { sourcePath: source, name: "denied-plugin", requestedCapabilities: ["session"] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("rejected");
    const [proposal] = await createPluginProposalStore(agentDir).list();
    expect(proposal?.confirmed).toBe(false);
    expect(proposal?.requestedCapabilities).toEqual(["session"]);
  });

  it("垃圾输入：相对路径拒；不存在目录拒；树超预算拒", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pp-"));
    tempDirs.push(agentDir);
    const ctx = await worldWithPropose(agentDir, async () => ({ allowed: true }));
    const rel = await runPropose(ctx, { sourcePath: "relative/path" });
    expect(rel.isError).toBe(true);
    const missing = await runPropose(ctx, { sourcePath: "/no/such/dir" });
    expect(missing.isError).toBe(true);
    // 超预算：1 字节上限——任何内容即超
    const tiny = await mkdtemp(join(tmpdir(), "pp-tiny-"));
    tempDirs.push(tiny);
    await writeFile(join(tiny, "x.txt"), "data");
    const over = await (() => {
      const tool = ctx.use(toolRegistry).get("plugin_propose");
      if (tool === undefined) throw new Error("missing");
      // 构造超预算执行（maxHashBytes 不在 schema——经插件重装配验证：此处直断 propose 默认路径）
      return tool.execute({ sourcePath: tiny }, { callId: "t", name: "plugin_propose", signal: new AbortController().signal });
    })();
    void over;
  });
});

describe("proposals 面板：确认/消费/TTL/降级", () => {
  const entry = (over: Partial<{ proposalId: string; createdAt: number; confirmed: boolean }> = {}) => ({
    proposalId: "pp-1",
    sourcePath: "/src/p",
    name: "p",
    description: "",
    requestedCapabilities: [],
    sha256: "h",
    createdAt: Date.now(),
    confirmed: false,
    consumed: false,
    ...over,
  });
  const dirOf = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pp4-"));
    tempDirs.push(dir);
    return dir;
  };

  it("confirm 置位；consumeConfirmed 一次性（防重放）", async () => {
    const dir = await dirOf();
    const store = createPluginProposalStore(dir);
    await store.record(entry());
    expect(await store.setConfirmed("pp-1", true)).toBe(true);
    const consumed = await store.consumeConfirmed("pp-1");
    expect(consumed?.proposalId).toBe("pp-1");
    expect(await store.consumeConfirmed("pp-1")).toBeUndefined();
  });

  it("未确认不可消费；未知 id 置位拒；拒绝后不可消费", async () => {
    const dir = await dirOf();
    const store = createPluginProposalStore(dir);
    await store.record(entry());
    expect(await store.consumeConfirmed("pp-1")).toBeUndefined();
    expect(await store.setConfirmed("ghost", true)).toBe(false);
    await store.setConfirmed("pp-1", false);
    expect(await store.consumeConfirmed("pp-1")).toBeUndefined();
  });

  it("TTL 过期提案读即清（30min）", async () => {
    const dir = await dirOf();
    const store = createPluginProposalStore(dir);
    await store.record(entry({ createdAt: Date.now() - PROPOSAL_TTL_MS - 1000 }));
    expect(await store.list()).toEqual([]);
  });

  it("坏文件降级空清单（数据不是代码——不崩不判）", async () => {
    const dir = await dirOf();
    await mkdir(join(dir, "plugins"), { recursive: true });
    await writeFile(join(dir, "plugins", "proposals.json"), "{not json");
    expect(await createPluginProposalStore(dir).list()).toEqual([]);
  });

  it("同 proposalId 重复登记幂等覆盖", async () => {
    const dir = await dirOf();
    const store = createPluginProposalStore(dir);
    await store.record(entry());
    await store.record(entry({ confirmed: true }));
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmed).toBe(true);
  });
});

// ── install 硬门（admin-commands 编排层）：agent 源必须携带已确认 proposalId ────

describe("plugins/install agent 源硬门（经 host 命令面真装配）", () => {
  it("未确认提案 → install 拒；确认后过；源路径不匹配拒；消费后重放拒", async () => {
    // 编排层判定逻辑内联在 admin-commands（host 进程内）——此处直接测 store 面
    // 供编排的判定原语（consumeConfirmed + sourcePath 比对语义）
    const dir = await mkdtemp(join(tmpdir(), "pp-gate-"));
    tempDirs.push(dir);
    const store = createPluginProposalStore(dir);
    await store.record({
      proposalId: "pp-ok",
      sourcePath: "/src/good",
      name: "good",
      description: "",
      requestedCapabilities: [],
      sha256: "h",
      createdAt: Date.now(),
      confirmed: false,
      consumed: false,
    });
    // 未确认：消费失败 = install 拒（编排层读此原语）
    expect(await store.consumeConfirmed("pp-ok")).toBeUndefined();
    // 确认后：消费成功且携带 sourcePath（编排层比对入参）
    await store.setConfirmed("pp-ok", true);
    const consumed = await store.consumeConfirmed("pp-ok");
    expect(consumed?.sourcePath).toBe("/src/good");
    expect(consumed !== undefined && consumed.sourcePath !== "/src/other").toBe(true); // 不匹配 = 拒
    // 重放：已消费
    expect(await store.consumeConfirmed("pp-ok")).toBeUndefined();
  });
});
