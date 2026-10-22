import { readData } from "../../../../core/src/validation";
import type { ProviderEnd, LlmResult } from "../contracts";
import { readLlmJson } from "./read-json";
import { object, text, keys } from "./read-values";
import { fail } from "./fail";

export function readProviderEnd(raw: unknown): LlmResult<ProviderEnd> {
  const read = readData(raw);

  if (!read.ok || !keys(read.value, ["reason", "rawReason"]))
    return fail("protocol-error", { phase: "output" });

  const snapshot = readLlmJson(read.value, { maxBytes: 4096 });

  if (!snapshot.ok || !object(snapshot.value) || !object(snapshot.value.reason))
    return fail("protocol-error", { phase: "output" });

  const { reason, rawReason } = snapshot.value;

  if (rawReason !== undefined && !text(rawReason, 1024))
    return fail("protocol-error", { phase: "output" });

  if (reason.kind === "stop") {
    if (
      !keys(reason, ["kind", "stopSequence"]) ||
      (reason.stopSequence !== undefined && !text(reason.stopSequence, 4096))
    )
      return fail("protocol-error", { phase: "output" });
  } else if (["tool-calls", "refusal", "content-filter", "pause"].includes(reason.kind as string)) {
    if (!keys(reason, ["kind"])) return fail("protocol-error", { phase: "output" });
  } else if (reason.kind === "length") {
    if (
      !keys(reason, ["kind", "limit"]) ||
      !["output", "context", "unknown"].includes(reason.limit as string)
    )
      return fail("protocol-error", { phase: "output" });
  } else if (reason.kind !== "other" || !keys(reason, ["kind", "raw"]) || !text(reason.raw, 1024))
    return fail("protocol-error", { phase: "output" });

  return { ok: true, value: snapshot.value as unknown as ProviderEnd };
}
