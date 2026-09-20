// host 管理命令面（DESIGN §3.9）：settings/models/agents/skills 命令注册
// （settings/get·set 与 skills/set_enabled 含项目级 cwd 形态）+ workspace/trust
// 信任注册表管理 + permission 双域分叉（无 threadId 全局本地；live 交池
// HOST_RELAYED——返回 false 由调用方交池；parked/dead 直答）。
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import {
  mergeSettings,
  normalizeCwd,
  projectSettingsPath,
  readHubSettings,
  readProjectSettings,
  updateHubSettings,
  updateSettingsFile,
  validateSettingValue,
} from "../shared/settings-store.ts";
import { metaTailOf } from "../shared/meta-fold.ts";
import { addModel, removeModel } from "./models-admin.ts";
import { createUserAgentType, removeUserAgentType } from "./agents-admin.ts";
import { knownSkillNames, listSkills, removeSkill, setSkillEnabled } from "./skills-admin.ts";
import type { ThreadTable } from "./thread-table.ts";
import type { TrustStore } from "./trust-store.ts";

export interface AdminCommandsDeps {
  agentDir: string;
  sessionsRoot: string;
  table: ThreadTable;
  trust: TrustStore;
  respond: (id: string | undefined, command: string, result: { data?: unknown; error?: string }) => void;
}

/** 信任 cwd 全集（注册表 ∪ live trusted——规范化）——skills/remove 的 project 判定用 */
async function trustedCwdsOf(deps: AdminCommandsDeps): Promise<string[]> {
  const registry = await deps.trust.list();
  const live: string[] = [];
  for (const entry of deps.table.list()) {
    if (entry.trusted) live.push(await normalizeCwd(entry.cwd));
  }
  return [...new Set([...registry, ...live])];
}

/** cwd 形态的门禁与规范化（未过门禁返回拒绝文案） */
async function gatedCwd(trust: TrustStore, table: ThreadTable, raw: string): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  if (!raw.startsWith("/")) {
    return { ok: false, error: `invalid workspace path: ${raw}` };
  }
  const cwd = await normalizeCwd(raw);
  if (!(await trust.isTrusted(cwd, table))) {
    return { ok: false, error: `untrusted workspace: ${cwd} (trust it via workspace/trust or a trusted thread start)` };
  }
  return { ok: true, cwd };
}

type LocalHandler = (input: { type?: unknown; id?: unknown; [key: string]: unknown }, id: string | undefined) => Promise<void> | void;

const PERMISSION_MODES: readonly string[] = ["plan", "auto", "full"];

/** parked/dead 会话的权限档（get_mode 直读——免唤醒）：WAL 尾值 > 项目(trusted)
 *  > 用户 > 内置缺省——source 四态（回退链） */
async function parkedPermissionMode(deps: AdminCommandsDeps, threadId: string): Promise<{ mode: string; source: "session" | "project" | "user" | "default" }> {
  const snapshot = await createArchiveReader(deps.sessionsRoot).read(threadId as never).catch(() => undefined);
  const mode = snapshot !== undefined && snapshot.ok ? metaTailOf(snapshot.value.events, "permission-mode") : undefined;
  if (typeof mode === "string" && PERMISSION_MODES.includes(mode)) return { mode, source: "session" };
  const entry = deps.table.get(threadId);
  if (entry !== undefined && entry.sessionPath !== null && (entry.trusted || (await deps.trust.isTrusted(entry.cwd, deps.table)))) {
    const project = (await readProjectSettings(entry.cwd))["permission.defaultMode"];
    if (project !== undefined) return { mode: project, source: "project" };
  }
  const user = (await readHubSettings(deps.agentDir))["permission.defaultMode"];
  if (user !== undefined) return { mode: user, source: "user" };
  return { mode: "auto", source: "default" };
}

export function createAdminCommands(deps: AdminCommandsDeps) {
  /** permission 双域分叉：undefined = 非本命令族（继续常规路由）；true = 已应答；
   *  false = live 形态交池（HOST_RELAYED） */
  async function permissionDual(input: { type?: unknown; id?: unknown; [key: string]: unknown }, id: string | undefined): Promise<boolean | undefined> {
    const type = typeof input.type === "string" ? input.type : "";
    if (type !== "permission/set_mode" && type !== "permission/get_mode") return undefined;
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    if (threadId === "") {
      if (type === "permission/get_mode") {
        const values = await readHubSettings(deps.agentDir);
        deps.respond(id, type, { data: { mode: values["permission.defaultMode"] ?? "auto", source: "default" } });
        return true;
      }
      const verdict = validateSettingValue("permission.defaultMode", input.mode);
      if (!verdict.ok) {
        deps.respond(id, type, { error: `invalid permission mode: ${String(input.mode)}` });
        return true;
      }
      await updateHubSettings(deps.agentDir, (current) => ({ ...current, "permission.defaultMode": input.mode as never }));
      deps.respond(id, type, {});
      return true;
    }
    const entry = deps.table.get(threadId);
    if (entry === undefined) {
      deps.respond(id, type, { error: "Unknown threadId" });
      return true;
    }
    if (entry.state === "parked" || entry.state === "dead") {
      if (type === "permission/get_mode") {
        deps.respond(id, type, { data: await parkedPermissionMode(deps, threadId) });
      } else {
        deps.respond(id, type, { error: "thread not live" });
      }
      return true;
    }
    return false; // live/spawning/retiring → 交池转发 worker
  }

  function register(handlers: Map<string, LocalHandler>): void {
    handlers.set("settings/get", async (input, id) => {
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      if (rawCwd === undefined) {
        const values = await readHubSettings(deps.agentDir);
        // 陈旧名单惰性滤除：未知名不回显（不写回——盘上事实不动）
        if (values["skills.disabled"] !== undefined) {
          const known = new Set(await knownSkillNames());
          values["skills.disabled"] = values["skills.disabled"].filter((name) => known.has(name));
        }
        deps.respond(id, "settings/get", { data: { values } });
        return;
      }
      const gate = await gatedCwd(deps.trust, deps.table, rawCwd);
      if (!gate.ok) {
        deps.respond(id, "settings/get", { error: gate.error });
        return;
      }
      // 门禁通过后才扫项目目录
      const [user, project] = await Promise.all([readHubSettings(deps.agentDir), readProjectSettings(gate.cwd)]);
      const merged = mergeSettings(user, project);
      if (merged.values["skills.disabled"] !== undefined) {
        const known = new Set(await knownSkillNames(gate.cwd));
        merged.values["skills.disabled"] = merged.values["skills.disabled"].filter((name) => known.has(name));
      }
      deps.respond(id, "settings/get", { data: { values: merged.values, sources: merged.sources, raw: { project, user } } });
    });
    handlers.set("settings/set", async (input, id) => {
      const key = typeof input.key === "string" ? input.key : "";
      const verdict = validateSettingValue(key, input.value);
      if (!verdict.ok) {
        deps.respond(id, "settings/set", { error: verdict.error });
        return;
      }
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      const gate = rawCwd !== undefined ? await gatedCwd(deps.trust, deps.table, rawCwd) : undefined;
      if (gate !== undefined && !gate.ok) {
        deps.respond(id, "settings/set", { error: gate.error });
        return;
      }
      if (verdict.key === "skills.disabled") {
        // 名单键白名单收紧（只收合并清单内的名字——cwd 形态含 project 层）
        const known = new Set(await knownSkillNames(gate?.ok ? gate.cwd : undefined));
        const unknown = (input.value as string[]).filter((name) => !known.has(name));
        if (unknown.length > 0) {
          deps.respond(id, "settings/set", { error: `invalid setting value: skills.disabled contains unknown skill: ${unknown.join(", ")}` });
          return;
        }
      }
      if (gate?.ok === true) {
        // 项目级：目录自建 + 整替目标级名单
        await mkdir(dirname(projectSettingsPath(gate.cwd)), { recursive: true });
        await updateSettingsFile(projectSettingsPath(gate.cwd), (current) => ({ ...current, [verdict.key]: input.value as never }));
      } else {
        await updateHubSettings(deps.agentDir, (current) => ({ ...current, [verdict.key]: input.value as never }));
      }
      deps.respond(id, "settings/set", {});
    });
    handlers.set("workspace/trust", async (input, id) => {
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      if (rawCwd === undefined) {
        deps.respond(id, "workspace/trust", { data: { trusted: await deps.trust.list() } });
        return;
      }
      if (!rawCwd.startsWith("/")) {
        deps.respond(id, "workspace/trust", { error: `invalid workspace path: ${rawCwd}` });
        return;
      }
      if (input.trusted !== true && input.trusted !== false) {
        deps.respond(id, "workspace/trust", { error: "invalid setting value: trusted must be a boolean" });
        return;
      }
      if (input.trusted) await deps.trust.trust(rawCwd);
      else await deps.trust.untrust(rawCwd);
      deps.respond(id, "workspace/trust", {});
    });
    handlers.set("models/add", async (input, id) => {
      const outcome = await addModel(deps.agentDir, input);
      deps.respond(id, "models/add", outcome.ok ? { data: { model: outcome.model } } : { error: outcome.error });
    });
    handlers.set("models/remove", async (input, id) => {
      const outcome = await removeModel(deps.agentDir, typeof input.id === "string" ? input.id : "");
      deps.respond(id, "models/remove", outcome.ok ? {} : { error: outcome.error });
    });
    handlers.set("agents/create", async (input, id) => {
      const outcome = await createUserAgentType(input);
      deps.respond(id, "agents/create", outcome.ok ? { data: { path: outcome.path } } : { error: outcome.error });
    });
    handlers.set("agents/remove", async (input, id) => {
      const outcome = await removeUserAgentType(typeof input.name === "string" ? input.name : "");
      deps.respond(id, "agents/remove", outcome.ok ? {} : { error: outcome.error });
    });
    handlers.set("skills/list", async (input, id) => {
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      const gate = rawCwd !== undefined ? await gatedCwd(deps.trust, deps.table, rawCwd) : undefined;
      if (gate !== undefined && !gate.ok) {
        deps.respond(id, "skills/list", { error: gate.error });
        return;
      }
      const outcome = await listSkills({ agentDir: deps.agentDir, ...(gate?.ok === true ? { cwd: gate.cwd } : {}) });
      deps.respond(id, "skills/list", { data: { skills: outcome.skills } });
    });
    handlers.set("skills/set_enabled", async (input, id) => {
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      const gate = rawCwd !== undefined ? await gatedCwd(deps.trust, deps.table, rawCwd) : undefined;
      if (gate !== undefined && !gate.ok) {
        deps.respond(id, "skills/set_enabled", { error: gate.error });
        return;
      }
      const outcome = await setSkillEnabled({
        agentDir: deps.agentDir,
        name: typeof input.name === "string" ? input.name : "",
        enabled: input.enabled === true,
        ...(gate?.ok === true ? { cwd: gate.cwd } : {}),
      });
      // 带 cwd 形态：enable 后并集仍含 → stillDisabled 回显（by 恒 user 级）
      const extra = outcome.ok && gate?.ok === true && outcome.stillDisabled !== undefined
        ? { data: { stillDisabled: true, by: outcome.stillDisabled } }
        : {};
      deps.respond(id, "skills/set_enabled", outcome.ok ? extra : { error: outcome.error });
    });
    handlers.set("skills/remove", async (input, id) => {
      const outcome = await removeSkill({
        name: typeof input.name === "string" ? input.name : "",
        trustedCwds: await trustedCwdsOf(deps),
      });
      deps.respond(id, "skills/remove", outcome.ok ? {} : { error: outcome.error });
    });
  }

  return { register, permissionDual };
}
