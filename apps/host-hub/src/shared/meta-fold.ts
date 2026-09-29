import type { SessionEvent } from "@x-harness/session";

export type MetaRecord = Record<string, unknown>;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function foldMeta(events: readonly SessionEvent[]): MetaRecord {
  const out: MetaRecord = Object.create(null);
  for (const event of events) {
    if (event.type === "session/meta" && !UNSAFE_KEYS.has(event.data.key)) out[event.data.key] = event.data.value;
  }
  return out;
}

export interface DialFact {
  provider: string;
  model: string;
}

function metaDialOf(event: SessionEvent): DialFact | undefined {
  if (event.type !== "session/meta" || event.data.key !== "dial") return undefined;
  const value = event.data.value;
  if (typeof value !== "object" || value === null) return undefined;
  const model = (value as { model?: unknown }).model;
  if (typeof model !== "string" || model === "") return undefined;
  const provider = (value as { provider?: unknown }).provider;
  return { provider: typeof provider === "string" ? provider : "", model };
}

export function foldDial(events: readonly SessionEvent[], fallback: DialFact): DialFact {
  for (let i = events.length - 1; i >= 0; i--) {
    const dial = metaDialOf(events[i] as SessionEvent);
    if (dial !== undefined) return { provider: dial.provider !== "" ? dial.provider : fallback.provider, model: dial.model };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "request/header" && event.data.model !== "") {
      return { provider: event.data.provider ?? fallback.provider, model: event.data.model };
    }
  }
  return fallback;
}

export function metaTailOf(events: readonly SessionEvent[], key: string): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "session/meta" && event.data.key === key) return event.data.value;
  }
  return undefined;
}
