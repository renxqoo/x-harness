// PERMISSION-V2 worker 命令面（worker-meta-commands）：permission/grant 三作用域写入
// （session=授权桶 / project|user=grantStore 持久面）、permission/list_rules、
// permission/remove_rule（settings 落盘删除）——stub rt 直驱 handler，不依赖真装配。

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "@x-harness/core";
import { GrantsRegistry, permissionGrants, permissionGrantStore } from "@x-harness/permission";
import { projectSettingsPath, readSettingsFile } from "../shared/settings-store.ts";
import { createWorkerCommands } from "../worker/worker-commands.ts";
import type { CommandInput, WorkerRuntime } from "../worker/worker-commands.ts";

interface Harness {
  rt: WorkerRuntime;
  handlers: Map<string, (input: CommandInput) => Promise<void>>;
  out: { id?: string; command?: string; error?: { message: string }; data?: unknown }[];
  grants: GrantsRegistry;
  agentDir: string;
  cwd: string;
}

let root = "";
let harness: Harness | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-grantcmd-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  harness = undefined;
});

async function makeHarness(fields: { trusted?: boolean } = {}): Promise<Harness> {
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  await mkdir(join(agentDir), { recursive: true });
  await mkdir(join(cwd, ".x-harness"), { recursive: true });
  const grants = new GrantsRegistry();
  const ctx = createContext();
  ctx.provide(permissionGrants, grants);
  ctx.provide(permissionGrantStore, {
    write: async (scope, entry) => {
      const path = scope === "user" ? join(agentDir, "hub-settings.json") : projectSettingsPath(cwd);
      const current = await readSettingsFile(path);
      const rules = current["permission.rules"] ?? [];
      if (rules.some((r) => r.tool === entry.tool && r.pattern === entry.pattern)) return { ok: true };
      const next = JSON.stringify({ ...current, "permission.rules": [...rules, entry] });
      await writeFile(path, next, "utf8");
      return { ok: true };
    },
  });
  const out: Harness["out"] = [];
  const rt = {
    state: {
      handle: { agent: { session: { id: "s-grant" } } },
      world: { ctx },
      catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
      dial: { provider: "script", model: "script-1" },
      thinking: undefined,
      permissionService: undefined,
      delegation: undefined,
      commands: undefined,
      threadId: "s-grant",
      sessionPath: "",
      cwd,
      trusted: fields.trusted ?? true,
      skillsDirs: [],
      skillsDisabled: new Set(),
      scriptAdapter: undefined,
    },
    emitLine: (line: string) => void out.push(JSON.parse(line) as Harness["out"][number]),
    agentDir,
    sessionsRoot: join(agentDir, "sessions"),
    broker: undefined as never,
    bash: undefined as never,
    inflight: undefined as never,
    inflightState: undefined as never,
    bridge: undefined as never,
    thinkingFallback: undefined,
    permissionModeSource: "default" as const,
  } as unknown as WorkerRuntime;
  const handlers = createWorkerCommands(rt);
  return { rt, handlers, out, grants, agentDir, cwd };
}

async function send(name: string, input: Record<string, unknown>): Promise<void> {
  const h = harness;
  if (h === undefined) throw new Error("harness not initialized");
  await h.handlers.get(name)?.({ id: `q-${name}`, threadId: "s-grant", command: name, ...input } as CommandInput);
}

describe("permission/grant", () => {
  test("session 作用域：授权桶写入 + list_rules 可见", async () => {
    harness = await makeHarness();
    await send("permission/grant", { rule: "Bash(mytool:*):allow", scope: "session" });
    expect(harness.out.at(-1)?.error).toBeUndefined();
    expect(harness.grants.rulesOf("s-grant" as never)).toHaveLength(1);
    await send("permission/list_rules", {});
    const data = harness.out.at(-1)?.data as { rules: { tool: string; pattern: string; scope: string }[] };
    expect(data.rules).toEqual([{ tool: "Bash", pattern: "mytool:*", verdict: "allow", nature: "grant", at: expect.any(Number), scope: "session" }]);
  });

  test("project 作用域：settings 落盘（grantStore 写入）+ remove_rule 删除往返", async () => {
    harness = await makeHarness({ trusted: true });
    await send("permission/grant", { rule: "Bash(npm install:*):allow", scope: "project" });
    expect(harness.out.at(-1)?.error).toBeUndefined();
    const stored = await readSettingsFile(projectSettingsPath(harness.cwd));
    expect(stored["permission.rules"]).toEqual([{ tool: "Bash", pattern: "npm install:*", verdict: "allow", nature: "grant", at: expect.any(Number) }]);
    await send("permission/remove_rule", { scope: "project", tool: "Bash", pattern: "npm install:*" });
    expect(harness.out.at(-1)?.data).toMatchObject({ removed: true });
    const after = await readSettingsFile(projectSettingsPath(harness.cwd));
    expect(after["permission.rules"]).toEqual([]); // 空表——条目已删
  });

  test("入参守门：非 allow 规则拒；坏形态拒；session 删除引导", async () => {
    harness = await makeHarness();
    await send("permission/grant", { rule: "Bash(rm:*):deny", scope: "session" });
    expect(harness.out.at(-1)?.error?.message).toContain("allow rules only");
    await send("permission/grant", { rule: "Bash(broken", scope: "user" });
    expect(harness.out.at(-1)?.error).toBeDefined();
    await send("permission/remove_rule", { scope: "session", tool: "Bash", pattern: "x" });
    expect(harness.out.at(-1)?.error?.message).toContain("session rules evict");
  });
});

describe("permission/grant 服务缺席腿", () => {
  test("无 world（服务未装配）：grant/list 走 internal 空态不崩", async () => {
    harness = await makeHarness();
    harness.rt.state.world = undefined;
    await send("permission/grant", { rule: "Bash(x:*):allow", scope: "session" });
    expect(harness.out.at(-1)?.error?.message).toContain("unavailable");
    await send("permission/grant", { rule: "Bash(x:*):allow", scope: "project" });
    expect(harness.out.at(-1)?.error?.message).toContain("unavailable");
    await send("permission/list_rules", {});
    expect(harness.out.at(-1)?.data).toEqual({ rules: [] });
  });
});
