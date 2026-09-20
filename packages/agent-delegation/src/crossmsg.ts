// 跨进程发送与一次性空闲订阅（docs/AGENT-DELEGATION.md §5.2-4b/§5.4）：box 域寻址
// （裸名唯一活箱 / name [ref] 消歧）；notify_when_idle 双向闭窗（写订阅前后各查一次
// 目标状态——错过 idle 事件窗口的修复）；仅根会话可用。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionId } from "@x-harness/session";

import type { LiveBox, MailboxService } from "@x-harness/session-mailbox";
import type { Lineage } from "./lineage.ts";

export interface CrossDeps {
  readonly service: MailboxService;
  readonly loop: AgentLoopService;
  readonly box: string;
  readonly mainSession: SessionId;
  readonly lineage: Lineage;
}

export interface CrossMessageInput {
  readonly to: string;
  readonly message?: string;
  readonly notify_when_idle?: boolean;
}

export type CrossOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

const WITH_REF = /^(.+) \[([0-9a-f]{6})\]$/;

/** box 域解析：裸名唯一活箱（排除自己）；name [ref] 按 box ref 精确 */
async function resolveBox(deps: CrossDeps, to: string): Promise<{ ok: true; box: LiveBox } | { ok: false; reason: string }> {
  const boxes = (await deps.service.discover()).filter((box) => box.name !== deps.box);
  const refHit = WITH_REF.exec(to);
  if (refHit !== null) {
    const name = refHit[1] as string;
    const ref = refHit[2] as string;
    const hits = boxes.filter((box) => box.name === name && box.ref === ref);
    if (hits.length === 1) return { ok: true, box: hits[0] as LiveBox };
    return { ok: false, reason: `not-found:'${to}'; no live local session matches` };
  }
  // box 名 = 目录名（mkdir 排他）——同 root 无重名，ambiguous 按构造不可达
  const hit = boxes.find((box) => box.name === to);
  return hit === undefined
    ? { ok: false, reason: `not-found:${to}; use list_agents to see addressable agents and sessions` }
    : { ok: true, box: hit };
}

export async function sendCross(deps: CrossDeps, caller: SessionId | undefined, input: CrossMessageInput): Promise<CrossOutcome> {
  if (caller === undefined) return { ok: false, reason: "invalid-args:agent tools are only available inside an agent session" };
  const resolved = await resolveBox(deps, input.to);
  if (!resolved.ok) return resolved;
  const target = resolved.box;

  if (input.message !== undefined) {
    const sent = await deps.service.send(target.name, { from: deps.box, message: input.message, kind: "message" });
    if (!sent.ok) return { ok: false, reason: sent.reason ?? `not-live:${target.name}` };
  }

  if (input.notify_when_idle === true) {
    // 双向闭窗（§5.4）：(a) 写订阅前已 idle → 立即投 notice 不写订阅；(b) 写后复查翻转。
    // 「已空闲」的通知直达本进程 main（订阅方是我——不走目标信箱绕行）
    if (target.status === "idle") {
      const noticed = await deliverNoticeLocally(deps, target.name);
      return { ok: true, text: crossText(target.name, input.message !== undefined, noticed) };
    }
    await deps.service.subs.add(target.name, deps.box);
    const recheck = (await deps.service.discover()).find((box) => box.name === target.name);
    if (recheck?.status === "idle") {
      const noticed = await deliverNoticeLocally(deps, target.name);
      return { ok: true, text: crossText(target.name, input.message !== undefined, noticed) };
    }
  }
  return { ok: true, text: crossText(target.name, input.message !== undefined, false) };
}

/** 已空闲的即时通知：本进程 main 直投（true=送达） */
async function deliverNoticeLocally(deps: CrossDeps, target: string): Promise<boolean> {
  const mainHandle = deps.loop.get(deps.mainSession);
  if (mainHandle === undefined) return false;
  try {
    mainHandle.agent.steer(`<cross-session-message from="${target}">[Cross-session idle notice] ${target} is already idle</cross-session-message>`);
    return true;
  } catch {
    return false;
  }
}

function crossText(target: string, hadMessage: boolean, noticedNow: boolean): string {
  const parts = [hadMessage ? `Delivered to ${target} (local session).` : `Subscribed to ${target} (pure subscription).`];
  parts.push(noticedNow ? "It is idle — the idle notice was sent immediately." : "A [Cross-session idle notice] arrives once when it next goes idle.");
  return parts.join(" ");
}
