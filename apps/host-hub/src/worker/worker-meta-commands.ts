// 会话级设置命令（DESIGN §3.9 worker 面）：set/get_thinking_level（session/meta
// 独立键持久化 + agentRequest 挂点下一 turn 生效——写者 append+flush 直写纪律；
// 词表校验先于流式拒）与 permission/set_mode|get_mode（permissionMode 服务即时切 +
// WAL 持久化——唤醒无回落；controller.set 后置到 flush 成功）。
import { respond, requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { CommandInput, Handler, WorkerRuntime } from "./worker-commands.ts";
import {
  currentDialOf,
  metaTailOf,
  permissionModeOf,
  thinkingLevelOf,
  thinkingUnsupported,
  PERMISSION_MODES,
  THINKING_LEVELS,
  META_KEY_PERMISSION,
  META_KEY_THINKING,
} from "./meta-state.ts";

export function registerMetaCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("set_thinking_level", async (input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "set_thinking_level" });
    if (session === undefined) return;
    const level = input.level;
    if (typeof level !== "string" || !THINKING_LEVELS.includes(level as never)) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: `invalid thinking level: ${String(level)}` });
      return;
    }
    // 在飞拒 = 受理窗口同口径（pendingSends ∨ streaming）——已 ack 未起跑的 turn
    // 不得捡新档
    if (rt.pendingSends > 0 || rt.bridge.isStreaming()) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: "thread is streaming" });
      return;
    }
    // 写前单点：当前拨号换 thinking（provider/model 原样保留）
    const dial = currentDialOf(session.events(), rt.state.dial);
    const unsupported = thinkingUnsupported(rt.state.catalog, dial, level as never);
    if (unsupported !== undefined) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: unsupported });
      return;
    }
    const append = session.append("session/meta", { key: META_KEY_THINKING, value: level });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: append.reason });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "set_thinking_level", error: flushed.reason });
      return;
    }
    respond(rt, { id: input.id, command: "set_thinking_level" });
  });

  handlers.set("get_thinking_level", wrapSyncHandler((input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "get_thinking_level" });
    if (session === undefined) return;
    // 尾值存在 → session；无尾值 → 装配物化归因（user/project 四态溯源）；皆无 → off
    const walLevel = thinkingLevelOf(metaTailOf(session.events(), META_KEY_THINKING));
    if (walLevel !== undefined) {
      respond(rt, { id: input.id, command: "get_thinking_level", data: { level: walLevel, source: "session" } });
      return;
    }
    const fallback = rt.thinkingFallback;
    respond(rt, {
      id: input.id,
      command: "get_thinking_level",
      data: fallback !== undefined ? { level: fallback.level, source: fallback.source } : { level: "off", source: "off" },
    });
  }));

  handlers.set("permission/set_mode", async (input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/set_mode" });
    if (session === undefined) return;
    const mode = input.mode;
    if (typeof mode !== "string" || !PERMISSION_MODES.includes(mode)) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: `invalid permission mode: ${String(mode)}` });
      return;
    }
    const append = session.append("session/meta", { key: META_KEY_PERMISSION, value: mode });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: append.reason });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "permission/set_mode", error: flushed.reason });
      return;
    }
    // 即时切档后置到持久化成功（报失败但提权成功是最坏方向——安全不变量）
    rt.state.permissionService?.set(permissionModeOf(mode) as "plan" | "auto" | "full");
    respond(rt, { id: input.id, command: "permission/set_mode" });
  });

  handlers.set("permission/get_mode", wrapSyncHandler((input: CommandInput) => {
    const session = requireThread(rt, { ...input, command: "permission/get_mode" });
    if (session === undefined) return;
    // source 判据：WAL 有档 → session；否则装配来源快照（四态）
    const walMode = permissionModeOf(metaTailOf(session.events(), META_KEY_PERMISSION));
    const current = rt.state.permissionService?.get();
    respond(rt, {
      id: input.id,
      command: "permission/get_mode",
      data: {
        mode: walMode ?? current ?? "auto",
        source: walMode !== undefined ? "session" : (rt.permissionModeSource ?? "default"),
      },
    });
  }));
}
