import type { Result } from "../../../core/src/index";
import { createFault, readData, readJsonValue } from "../../../core/src/validation";
import type { LogInput } from "./types";

export function readLog(input: unknown): Result<LogInput> {
  const read = readData(input);
  if (!read.ok || Object.keys(read.value).some((key) => key !== "message" && key !== "fields") ||
      typeof read.value.message !== "string" || read.value.message.length > 4096) return createFault("invalid-input");
  const snapshot = readJsonValue({ message: read.value.message, ...(read.value.fields !== undefined ? { fields: read.value.fields } : {}) });
  if (!snapshot.ok) return createFault("invalid-input");
  return { ok: true, value: snapshot.value as unknown as LogInput };
}
