export type ErrorFamily = "transport-retryable" | "http-4xx" | "auth" | "context-overflow" | "unknown";

const TRANSPORT_CODES: ReadonlySet<string> = new Set(["network", "http-408", "http-429", "http-500", "http-502", "http-503", "http-504"]);
const AUTH_CODES: ReadonlySet<string> = new Set(["http-401", "http-403"]);

export function classifyFailure(code: string | undefined): ErrorFamily {
  if (code !== undefined && TRANSPORT_CODES.has(code)) return "transport-retryable";
  if (code !== undefined && AUTH_CODES.has(code)) return "auth";
  if (code === "context-overflow") return "context-overflow";
  if (code !== undefined && code.startsWith("http-4")) return "http-4xx";
  return "unknown";
}

export type FamilyAction = "respond" | "fail" | "skip";

export const DEFAULT_FAMILY_ACTIONS: Readonly<Record<ErrorFamily, FamilyAction>> = {
  "transport-retryable": "skip",
  "http-4xx": "respond",
  auth: "fail",
  "context-overflow": "fail",
  unknown: "respond",
};
