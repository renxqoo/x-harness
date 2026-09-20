// 会话级 meta 读口（DESIGN §3.6/§3.9/§3.3）：dial 双源尾值、thinking/permission/
// title 单键尾值——worker 命令面与装配初值共用单源。thinking 兼容校验（写前单点）
// 按目录快照判据：词表外 / reasoning:false / openai 协议（映射缺席挂账）。
import type { SessionEvent } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";
import { foldDial } from "../shared/meta-fold.ts";
import { metaTailOf } from "../shared/meta-fold.ts";

export { metaTailOf };
import type { DialFact } from "../shared/meta-fold.ts";
import { catalogEntryOf } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";

export const META_KEY_DIAL = "dial";
export const META_KEY_THINKING = "thinking";
export const META_KEY_PERMISSION = "permission-mode";
export const META_KEY_TITLE = "title";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
export const PERMISSION_MODES: readonly string[] = ["plan", "auto", "full"];

export function thinkingLevelOf(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function permissionModeOf(value: unknown): "plan" | "auto" | "full" | undefined {
  return typeof value === "string" && PERMISSION_MODES.includes(value) ? (value as "plan" | "auto" | "full") : undefined;
}

/** dial 双源读（meta 显式 > request/header 隐式 > 装配 fallback） */
export function currentDialOf(events: readonly SessionEvent[], fallback: DialFact): DialFact {
  return foldDial(events, fallback);
}

/** thinking 会话值（meta 尾值 > 装配 options——无则 undefined） */
export function currentThinkingOf(events: readonly SessionEvent[], optionsThinking: ThinkingLevel | undefined): ThinkingLevel | undefined {
  return thinkingLevelOf(metaTailOf(events, META_KEY_THINKING)) ?? optionsThinking;
}

/** permission 会话值（meta 尾值 > 装配初值） */
export function currentPermissionOf(events: readonly SessionEvent[], initial: "plan" | "auto" | "full"): "plan" | "auto" | "full" {
  return permissionModeOf(metaTailOf(events, META_KEY_PERMISSION)) ?? initial;
}

export function titleOf(events: readonly SessionEvent[]): string | undefined {
  const value = metaTailOf(events, META_KEY_TITLE);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** thinking 写前校验单点（set_thinking_level / set_model 保留档 / thread-start 显式
 *  档 / 装配物化四方共用）：非法组合写入前拒（不落 WAL）。 */
export function thinkingUnsupported(catalog: WorkerCatalog, dial: DialFact, thinking: ThinkingLevel | undefined): string | undefined {
  if (thinking === undefined || thinking === "off") return undefined;
  const provider = catalogEntryOf(catalog, dial);
  if (provider === undefined) return "model does not support thinking";
  if (provider.protocol === "openai") return "model does not support thinking"; // 协议映射缺席（挂账）
  if (catalog.modelMeta[dial.model]?.reasoning === false) return "model does not support thinking";
  return undefined;
}
