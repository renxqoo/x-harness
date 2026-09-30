import type { SessionEvent } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";
import type { ProfileId } from "@x-harness/permission";
import { PROFILE_IDS } from "@x-harness/permission";
import { foldDial } from "../shared/meta-fold.ts";
import { metaTailOf } from "../shared/meta-fold.ts";

export { metaTailOf };
import type { DialFact } from "../shared/meta-fold.ts";
import { catalogEntryOf, modelMetaOf } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";

export const META_KEY_DIAL = "dial";
export const META_KEY_THINKING = "thinking";
export const META_KEY_PERMISSION = "permission-mode";
export const META_KEY_TITLE = "title";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
export const PERMISSION_MODES: readonly string[] = [...PROFILE_IDS];

export function thinkingLevelOf(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

export function permissionModeOf(value: unknown): ProfileId | undefined {
  return typeof value === "string" && PERMISSION_MODES.includes(value) ? (value as ProfileId) : undefined;
}

export function currentDialOf(events: readonly SessionEvent[], fallback: DialFact): DialFact {
  return foldDial(events, fallback);
}

export function currentThinkingOf(events: readonly SessionEvent[], optionsThinking: ThinkingLevel | undefined): ThinkingLevel | undefined {
  return thinkingLevelOf(metaTailOf(events, META_KEY_THINKING)) ?? optionsThinking;
}

export function currentPermissionOf(events: readonly SessionEvent[], initial: ProfileId): ProfileId {
  return permissionModeOf(metaTailOf(events, META_KEY_PERMISSION)) ?? initial;
}

export function titleOf(events: readonly SessionEvent[]): string | undefined {
  const value = metaTailOf(events, META_KEY_TITLE);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function thinkingUnsupported(catalog: WorkerCatalog, dial: DialFact, thinking: ThinkingLevel | undefined): string | undefined {
  if (thinking === undefined || thinking === "off") return undefined;
  const provider = catalogEntryOf(catalog, dial);
  if (provider === undefined) return "model does not support thinking";
  if (modelMetaOf(catalog, dial)?.reasoning === false) return "model does not support thinking";
  return undefined;
}

export function imagesUnsupported(catalog: WorkerCatalog, dial: DialFact): string | undefined {
  if (modelMetaOf(catalog, dial)?.input?.includes("image") === true) return undefined;
  return "invalid images: model does not accept images";
}
