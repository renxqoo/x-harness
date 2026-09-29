import type { SessionUsage } from "@x-harness/token-meter";
import type { RouteUsage } from "@x-harness/token-meter";

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1_000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = count / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

function lastRoute(usage: SessionUsage): RouteUsage | undefined {
  const turns = usage.turns;
  const last = turns[turns.length - 1];
  const routes = last?.routes ?? [];
  return routes[routes.length - 1];
}

export function formatTurnLine(turn: number, usage: SessionUsage): string {
  const route = lastRoute(usage);
  const routeText = route === undefined ? "" : ` (${route.provider}/${route.model})`;
  return `[turn ${String(turn)}] ↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)} · ${formatTokens(usage.totalTokens)}${routeText}`;
}

export function formatSessionSummary(usage: SessionUsage): string {
  return `tokens: ↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)} · ${formatTokens(usage.totalTokens)} · attempts ${String(usage.attempts)} · turns ${String(usage.turns.length)}`;
}
