// DialogBroker（DESIGN §6）：ui_request 恰好 settle 一次（response / 强制超时 /
// abort——后两者默认 deny）；所有 ask 强制带超时（无超时永挂→永不 retire）；保留
// request 供 get_pending_dialogs 重建；RESERVED 帧头键与 __proto__ 注入过滤；
// 晚到 resolve 忽略返回 false。permissionBroker 服务与直执行 bash 准入共用本面。
import { randomUUID } from "node:crypto";
import { uiRequestFrame } from "../protocol/frames.ts";

/** ui_request 帧头保留键——payload 不得覆盖（帧构造面冲突；帧构造单源 uiRequestFrame） */
const RESERVED_KEYS = new Set(["type", "requestId", "threadId", "method"]);

export interface PendingDialog {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}

export interface DialogBrokerDeps {
  /** 帧出口（已串行） */
  sendFrame: (line: string) => void;
  /** confirm 类统一超时（缺省 5min——常量单点经调用方传入） */
  confirmTimeoutMs: number;
}

export interface ConfirmFields {
  tool: string;
  summary?: string;
  reason: string;
}

export function createDialogBroker(deps: DialogBrokerDeps) {
  const pending = new Map<
    string,
    { dialog: PendingDialog; settle: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function emitRequest(dialog: PendingDialog): void {
    const safePayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dialog.payload)) {
      if (RESERVED_KEYS.has(key) || key === "__proto__") continue;
      safePayload[key] = value;
    }
    deps.sendFrame(uiRequestFrame({ requestId: dialog.requestId, threadId: dialog.threadId, method: dialog.method, payload: safePayload }));
  }

  return {
    /** 发起 confirm：resolve(true/false)；超时/abort → false（默认拒绝） */
    confirm(threadId: string, fields: ConfirmFields): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const requestId = randomUUID();
        const dialog: PendingDialog = {
          requestId,
          threadId,
          method: "confirm",
          payload: { ...fields },
        };
        let settled = false;
        const settle = (value: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(value);
        };
        const timer = setTimeout(() => settle(false), deps.confirmTimeoutMs);
        pending.set(requestId, { dialog, settle, timer });
        emitRequest(dialog);
      });
    },
    /** ui_response 路由：未知/晚到静默忽略（恒 ack 由调用方保证） */
    resolve(requestId: string, payload: unknown): boolean {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      if (payload !== null && typeof payload === "object" && typeof (payload as { confirmed?: unknown }).confirmed === "boolean") {
        entry.settle((payload as { confirmed: boolean }).confirmed);
        return true;
      }
      entry.settle(false); // 坏形状按拒绝结算（恰一 settle 不破）
      return true;
    },
    /** abort/关闭：全部按默认拒绝结算 */
    denyAll(): void {
      for (const entry of pending.values()) entry.settle(false);
    },
    pendingCount(): number {
      return pending.size;
    },
    pendingAll(): PendingDialog[] {
      return [...pending.values()].map((entry) => entry.dialog);
    },
  };
}

export type DialogBroker = ReturnType<typeof createDialogBroker>;
