import { createHash } from "node:crypto";
import { stop } from "./fail";

export function digest(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function encodeLine(payload: unknown, checksum = digest(JSON.stringify(payload))): string {
  return `${JSON.stringify({ payload, checksum })}\n`;
}

export function parseLine(raw: Buffer): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, -1));
    const value: unknown = JSON.parse(text);

    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(value) !== text
    )
      stop("storage-corrupt");

    return value as Record<string, unknown>;
  } catch {
    stop("storage-corrupt");
  }
}

export function payload(line: Record<string, unknown>): Record<string, unknown> {
  if (
    Object.keys(line).join(",") !== "payload,checksum" ||
    typeof line.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(line.checksum) ||
    !line.payload ||
    typeof line.payload !== "object" ||
    Array.isArray(line.payload)
  )
    stop("storage-corrupt");

  return line.payload as Record<string, unknown>;
}
