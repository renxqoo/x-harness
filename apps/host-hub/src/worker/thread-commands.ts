import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSafeSessionId, mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";
import { permissionMode as permissionModeToken } from "@x-harness/permission";
import { delegationView } from "@x-harness/agent-delegation";
import { commandRegistry } from "@x-harness/commands";
import { hubError, CodedError, errorOfCause } from "../shared/errors.ts";
import { assembleWorkerAgent, teardownWorld } from "./assembly.ts";
import type { AssemblyResult } from "./assembly.ts";
import { forkInputVerdict, respond, requireThread, sessionOf } from "./worker-commands.ts";
import type { CommandInput, Handler, WorkerRuntime, WorkerState } from "./worker-commands.ts";
import type { EventBridge } from "./event-bridge.ts";
import { permissionModeOf, PERMISSION_MODES, THINKING_LEVELS, thinkingUnsupported } from "./meta-state.ts";
import { META_KEY_PERMISSION, META_KEY_THINKING } from "./meta-state.ts";
import { foldDial, metaTailOf } from "../shared/meta-fold.ts";
import { mergeSettings, normalizeCwd, projectSettingsPath, readHubSettings, readProjectSettings } from "../shared/settings-store.ts";
import type { HubSettings } from "../shared/settings-store.ts";

export async function workspaceTrusted(agentDir: string, cwd: string, selfTrusted: boolean): Promise<boolean> {
  if (selfTrusted) return true;
  const normalized = await normalizeCwd(cwd);
  try {
    const raw = await readFile(join(agentDir, "trusted-workspaces.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.some((item) => typeof item === "string" && item === normalized);
  } catch {
    return false;
  }
}

async function effectiveSettings(agentDir: string, cwd: string, trusted: boolean): Promise<{ values: HubSettings; user: HubSettings; project: HubSettings; projectHit: boolean }> {
  const user = await readHubSettings(agentDir);
  const projectHit = await workspaceTrusted(agentDir, cwd, trusted);
  if (!projectHit) return { values: user, user, project: {}, projectHit };
  const project = await readProjectSettings(cwd);
  return { values: mergeSettings(user, project).values, user, project, projectHit };
}

interface SessionParams {
  paramMode: import("@x-harness/permission").ProfileId | undefined;
  paramLevel: string | undefined;
}

interface SessionParamsInput {
  permissionMode?: unknown;
  thinkingLevel?: unknown;
  trusted?: unknown;
  [key: string]: unknown;
}

function settingsParamsOf(input: SessionParamsInput): SessionParams {
  const rawMode = input.permissionMode;
  const rawLevel = typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined;
  return {
    paramMode: typeof rawMode === "string" && PERMISSION_MODES.includes(rawMode) ? (rawMode as import("@x-harness/permission").ProfileId) : undefined,
    paramLevel: rawLevel !== undefined && THINKING_LEVELS.includes(rawLevel as ThinkingLevel) ? rawLevel : undefined,
  };
}

async function preReadCwd(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionsRoot, sessionId, "header.json"), "utf8");
    const parsed = JSON.parse(raw) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

interface AssemblyTarget {
  rt: { state: WorkerState; bridge: EventBridge };
  assembled: AssemblyResult;
  cwd: string;
  sessionsRoot: string;
}

function applyAssembly(target: AssemblyTarget): void {
  const { rt, assembled, cwd, sessionsRoot } = target;
  rt.state.handle = assembled.handle;
  rt.state.world = assembled.world;
  rt.state.catalog = assembled.catalog;
  rt.state.dial = assembled.dial;
  rt.state.thinking = assembled.thinking;
  rt.state.threadId = assembled.sessionId;
  rt.state.sessionPath = join(sessionsRoot, assembled.sessionId, "events.jsonl");
  rt.state.cwd = cwd;
  rt.state.skillsDirs = assembled.skillsDirs;
  rt.state.skillsDisabled = assembled.skillsDisabled;
  rt.state.scriptAdapter = assembled.scriptAdapter;
  rt.state.permissionService = assembled.world.ctx.tryUse(permissionModeToken);
  rt.state.delegation = assembled.world.ctx.tryUse(delegationView);
  rt.state.commands = assembled.world.ctx.tryUse(commandRegistry);
  rt.bridge.wire(assembled.world.ctx);
}

export async function assembleThread(rt: WorkerRuntime, plan: {
  fields: import("./assembly.ts").AssemblyFields;
  input: SessionParamsInput;
  cwdOf: (assembled: AssemblyResult) => string;
  sessionsRoot?: string;
  cwdHint?: string;
}): Promise<AssemblyResult> {
  const cwdHint = plan.cwdHint ?? plan.fields.cwd ?? process.cwd();
  const selfTrusted = rt.state.trusted || plan.input.trusted === true;
  const { values: settings, user: userFile, project: projectFile, projectHit } = await effectiveSettings(rt.agentDir, cwdHint, selfTrusted);
  applyFallbackSnapshots(rt, { settings, userFile, projectHit });
  const params = settingsParamsOf(plan.input);
  const initialMode = params.paramMode ?? settings["permission.defaultMode"] ?? "auto";
  const assembled = await assembleWorkerAgent({
    ...plan.fields,
    agentDir: rt.agentDir,
    ...(rt.proposals !== undefined ? { proposalStore: rt.proposals } : {}),
    confirm: (fields) => rt.broker.confirm(rt.state.threadId === "" ? "unassigned" : rt.state.threadId, fields),
    ...(settings["thinking.default"] !== undefined ? { thinkingDefault: settings["thinking.default"] } : {}),
    ...(settings["compaction.keepRecentTokens"] !== undefined ? { compactionKeepRecentTokens: settings["compaction.keepRecentTokens"] } : {}),
    ...(settings["compaction.keepMinTurns"] !== undefined ? { compactionKeepMinTurns: settings["compaction.keepMinTurns"] } : {}),
    permissionMode: initialMode,
    ...permissionFieldsOf(settings, userFile, projectFile) as Partial<import("./assembly.ts").AssemblyFields>,
  });
  const paramLevel = params.paramLevel;
  if (paramLevel !== undefined) {
    const unsupported = thinkingUnsupported(assembled.catalog, assembled.dial, paramLevel as ThinkingLevel);
    if (unsupported !== undefined) {
      await assembled.handle.dispose().catch(() => undefined);
      await teardownWorld(assembled.world);
      throw new CodedError("capability_thinking", `thinkingLevel rejected: ${unsupported}`);
    }
  }
  applyAssembly({ rt, assembled, cwd: plan.cwdOf(assembled), sessionsRoot: rt.sessionsRoot });
  await applySessionSettings(rt, { params });
  return assembled;
}

function applyFallbackSnapshots(rt: WorkerRuntime, files: { settings: HubSettings; userFile: HubSettings; projectHit: boolean }): void {
  rt.thinkingFallback = files.settings["thinking.default"] !== undefined
    ? {
        level: files.settings["thinking.default"],
        source: files.userFile["thinking.default"] !== files.settings["thinking.default"] && files.projectHit ? "project" : "user",
      }
    : undefined;
  const mergedMode = files.settings["permission.defaultMode"];
  const userMode = files.userFile["permission.defaultMode"];
  if (mergedMode !== undefined && mergedMode !== userMode && files.projectHit) rt.permissionModeSource = "project";
  else if (userMode !== undefined) rt.permissionModeSource = "user";
  else rt.permissionModeSource = "default";
}

async function applySessionSettings(rt: WorkerRuntime, fields: { params: SessionParams }): Promise<void> {
  const session = sessionOf(rt);
  if (session === undefined) return;
  const events = session.events();
  const walModeValid = permissionModeOf(metaTailOf(events, META_KEY_PERMISSION));
  if (fields.params.paramMode !== undefined && fields.params.paramMode !== walModeValid) {
    const append = session.append("session/meta", { key: META_KEY_PERMISSION, value: fields.params.paramMode });
    if (!append.ok) throw new CodedError("io_failed", append.reason);
  }
  if (fields.params.paramLevel !== undefined) {
    const append = session.append("session/meta", { key: META_KEY_THINKING, value: fields.params.paramLevel });
    if (!append.ok) throw new CodedError("io_failed", append.reason);
  }
  const flushed = await rt.state.world?.store.flush(session.id);
  if (flushed !== undefined && !flushed.ok) throw new CodedError("io_failed", flushed.reason);
  const finalMode = fields.params.paramMode ?? walModeValid;
  if (finalMode !== undefined) rt.state.permissionService?.set(finalMode);
}

export function resumeCwdOf(input: { cwd?: unknown; [key: string]: unknown }, assembled: AssemblyResult, fallback: string): string {
  if (typeof input.cwd === "string" && input.cwd !== "") return input.cwd;
  const headerCwd = assembled.handle.agent.session.header.cwd;
  if (typeof headerCwd === "string" && headerCwd !== "") return headerCwd;
  return fallback;
}

export async function doFork(rt: WorkerRuntime, input: CommandInput, command: string): Promise<void> {
  const session = requireThread(rt, { ...input, command });
  const world = rt.state.world;
  if (session === undefined || world === undefined) return;
  const events = session.events();
  const invalid = forkInputVerdict(rt, events.length - 1, input);
  if (invalid !== undefined) {
    respond(rt, { id: input.id, command, error: invalid });
    return;
  }
  const position = input.position === "at" ? "at" : "before";
  const seq = input.seq as number;
  const flushed = await world.store.flush(session.id);
  if (!flushed.ok) {
    respond(rt, { id: input.id, command, error: hubError("io_failed", flushed.reason) });
    return;
  }
  const previousThreadId = rt.state.threadId;
  const untilSeq = position === "at" ? seq : seq - 1;
  const currentDial = foldDial(events.slice(0, untilSeq + 1), rt.state.dial);
  const forked = await world.store.fork(session.id as SessionId, { untilSeq, id: mintSessionId() });
  if (!forked.ok) {
    respond(rt, { id: input.id, command, error: hubError("invalid_input", `invalid fork seq: ${forked.reason}`) });
    return;
  }
  const newId = forked.value.id;
  const disposed = world.store.dispose(newId);
  if (!disposed.ok) {
    respond(rt, { id: input.id, command, error: hubError("io_failed", `fork reassembly failed: ${disposed.reason}`) });
    return;
  }
  if (rt.state.delegation !== undefined && rt.state.handle !== undefined) {
    await rt.state.delegation.stopAll(rt.state.handle.agent.session.id, "fork-reassembly");
  }
  rt.bridge.unsubscribe();
  await rt.state.handle?.dispose();
  await teardownWorld(world);
  rt.state.handle = undefined;
  rt.state.world = undefined;
  rt.state.permissionService = undefined;
  rt.state.delegation = undefined;
  rt.state.commands = undefined;
  let assembled: import("./assembly.ts").AssemblyResult;
  try {
    assembled = await assembleThread(rt, {
      fields: {
        sessionsRoot: rt.sessionsRoot,
        cwd: rt.state.cwd,
        trusted: rt.state.trusted,
        resumeId: newId,
        dial: currentDial,
        env: rt.env,
      },
      input: {},
      cwdOf: () => rt.state.cwd,
    });
  } catch (error) {
    process.stderr.write(`hub:worker: fork reassembly failed: ${String(error)}\n`);
    const cause = errorOfCause(error);
    respond(rt, { id: input.id, command, error: { code: cause.code, message: `fork reassembly failed: ${cause.message}` } });
    rt.triggerShutdown();
    return;
  }
  respond(rt, {
    id: input.id,
    command,
    data: { threadId: newId, previousThreadId, sessionPath: rt.state.sessionPath, ...(assembled.gitBranch !== undefined ? { gitBranch: assembled.gitBranch } : {}) },
  });
}

let lifecycleChain: Promise<void> = Promise.resolve();

export function serializedLifecycle(run: () => Promise<void>): Promise<void> {
  const task = lifecycleChain.then(run);
  lifecycleChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function serialized(handler: Handler): Handler {
  return (input) => {
    const run = lifecycleChain.then(() => handler(input));
    lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function registerThreadCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("thread/start", async (input) => {
    if (rt.state.handle !== undefined) {
      respond(rt, { id: input.id, command: "thread/start", error: hubError("already_open", "already open") });
      return;
    }
    try {
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
      const cwd = await normalizeCwd(rawCwd);
      const trusted = input.trusted === true;
      const modelId = typeof input.modelId === "string" ? input.modelId : undefined;
      const assembled = await assembleThread(rt, {
        fields: {
          sessionsRoot: rt.sessionsRoot,
          cwd,
          trusted,
          ...(modelId !== undefined ? { modelId } : {}),
          env: rt.env,
        },
        input,
        cwdOf: () => cwd,
      });
      rt.state.trusted = trusted;
      let projectSettingsPresent: boolean | undefined;
      if (!(trusted || (await workspaceTrusted(rt.agentDir, cwd, false)))) {
        projectSettingsPresent = await readFile(projectSettingsPath(cwd)).then(
          () => true,
          () => false,
        );
      }
      respond(rt, {
        id: input.id,
        command: "thread/start",
        data: {
          threadId: rt.state.threadId,
          cwd,
          sessionPath: rt.state.sessionPath,
          ...(assembled.gitBranch !== undefined ? { gitBranch: assembled.gitBranch } : {}),
          ...(projectSettingsPresent === true ? { projectSettingsPresent: true } : {}),
        },
      });
    } catch (error) {
      respond(rt, { id: input.id, command: "thread/start", error: errorOfCause(error) });
    }
  });

  handlers.set("thread/resume", async (input) => {
    if (rt.state.handle !== undefined) {
      respond(rt, { id: input.id, command: "thread/resume", error: hubError("already_open", "already open") });
      return;
    }
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    const resumeId = sessionPath.split("/").at(-2) ?? "";
    if (!isSafeSessionId(resumeId)) {
      respond(rt, { id: input.id, command: "thread/resume", error: hubError("session_unreadable", "Session file not readable") });
      return;
    }
    try {
      const eventsFile = join(rt.sessionsRoot, resumeId, "events.jsonl");
      const headerFile = join(rt.sessionsRoot, resumeId, "header.json");
      const eventsExists = await stat(eventsFile).then(() => true, () => false);
      const headerExists = await stat(headerFile).then(() => true, () => false);
      if (!eventsExists || !headerExists) {
        respond(rt, { id: input.id, command: "thread/resume", error: hubError("session_unreadable", "Session file not readable") });
        return;
      }
      const trusted = input.trusted === true;
      const explicitCwdRaw = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      const explicitCwd = explicitCwdRaw !== undefined ? await normalizeCwd(explicitCwdRaw) : undefined;
      const cwdHint = explicitCwd ?? (await preReadCwd(rt.sessionsRoot, resumeId)) ?? rt.state.cwd;
      const assembled = await assembleThread(rt, {
        fields: {
          sessionsRoot: rt.sessionsRoot,
          cwd: explicitCwd ?? cwdHint,
          trusted,
          resumeId,
          env: rt.env,
        },
        input,
        cwdOf: (assembled) => resumeCwdOf(input, assembled, cwdHint),
        cwdHint,
      });
      rt.state.trusted = trusted;
      respond(rt, {
        id: input.id,
        command: "thread/resume",
        data: { threadId: rt.state.threadId, cwd: rt.state.cwd, sessionPath: rt.state.sessionPath, ...(assembled.gitBranch !== undefined ? { gitBranch: assembled.gitBranch } : {}) },
      });
    } catch (error) {
      const cause = errorOfCause(error);
      respond(rt, { id: input.id, command: "thread/resume", error: { code: cause.code, message: `cannot resume session: ${cause.message}` } });
    }
  });

  handlers.set("thread/stop", serialized(async (input) => {
    const handle = rt.state.handle;
    if (handle !== undefined) {
      if (rt.state.delegation !== undefined) {
        await rt.state.delegation.stopAll(handle.agent.session.id, "thread-stop");
      }
      await rt.inflight.abortAll();
      rt.bridge.unsubscribe();
      await handle.dispose();
      if (rt.state.world !== undefined) await teardownWorld(rt.state.world);
      rt.state.handle = undefined;
      rt.state.world = undefined;
      rt.state.threadId = "";
      rt.state.sessionPath = "";
      rt.state.permissionService = undefined;
      rt.state.delegation = undefined;
  rt.state.commands = undefined;
    }
    respond(rt, { id: input.id, command: "thread/stop" });
  }));
}

function permissionFieldsOf(settings: HubSettings, userFile: HubSettings, projectFile: HubSettings): {
  skillsDisabled?: readonly string[];
  pluginsDisabled?: readonly string[];
  permissionUserRules?: readonly import("@x-harness/permission").PermissionRule[];
  permissionProjectRules?: readonly import("@x-harness/permission").PermissionRule[];
  customProfiles?: readonly import("@x-harness/permission").PermissionProfile[];
} {
  const userRules = userFile["permission.rules"];
  const projectRules = projectFile["permission.rules"];
  return {
    ...(settings["skills.disabled"] !== undefined ? { skillsDisabled: settings["skills.disabled"] } : {}),
    ...(settings["plugins.disabled"] !== undefined ? { pluginsDisabled: settings["plugins.disabled"] } : {}),
    ...(userRules !== undefined && userRules.length > 0 ? { permissionUserRules: userRules.map((entry) => ({ ...entry, origin: "user" as const })) } : {}),
    ...(projectRules !== undefined && projectRules.length > 0 ? { permissionProjectRules: projectRules.map((entry) => ({ ...entry, origin: "project" as const })) } : {}),
    ...(settings["permission.profiles"] !== undefined && settings["permission.profiles"].length > 0 ? { customProfiles: settings["permission.profiles"] } : {}),
  };
}
