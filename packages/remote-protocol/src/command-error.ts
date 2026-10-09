export interface CommandError {
  code: string;
  message?: string;
}

export function commandError(code: string, message?: string): CommandError {
  return message === undefined ? { code } : { code, message };
}

export function readCommandError(value: unknown): CommandError | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const code = record["code"];
  if (typeof code !== "string" || code === "") return null;
  const message = record["message"];
  return typeof message === "string" ? { code, message } : { code };
}