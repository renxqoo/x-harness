const TARGET_KEYS = ["path", "paths", "command", "pattern"] as const;

export function summaryOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    if (strings !== undefined && strings.length > 0) {
      return strings.join(", ");
    }
  }
  return undefined;
}
