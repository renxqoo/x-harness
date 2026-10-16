import type { CoreFault, Result } from "./types";
import { coreFaultCodes } from "./fault-codes";
import { createFault } from "./create-fault";
import { readData } from "./read-data";
import { readJsonValue } from "./read-json-value";

export function readCoreFault(input: unknown): Result<CoreFault> {
  const read = readData(input);
  if (!read.ok) return createFault("invalid-result");
  const data = read.value;
  const identities = ["scopeId", "pluginName", "callId", "diagnosticId"];
  if (Object.keys(data).some((key) => !["source", "code", "message", "details", ...identities].includes(key)) ||
      data.source !== "core" || !coreFaultCodes.some((code) => code === data.code) || typeof data.message !== "string" ||
      identities.some((key) => data[key] !== undefined && typeof data[key] !== "string")) return createFault("invalid-result");
  if (data.details !== undefined) {
    const details = readJsonValue(data.details);
    if (!details.ok) return details;
    data.details = details.value;
  }
  return { ok: true, value: Object.freeze(data) as unknown as CoreFault };
}
