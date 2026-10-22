import type { ToolPreparationRequest, ToolDispatchRequest } from "./types";
import { createFault } from "../../../../core/src/validation";
import {
  preparationRequests as preparations,
  dispatchRequests as executions,
} from "../planning/shared";

export function createPreparationRequest(input: ToolPreparationRequest) {
  const request = Object.freeze({ ...input });
  preparations.add(request);
  return {
    request,
    close() {
      preparations.delete(request);
    },
  };
}

export function createDispatchRequest(input: ToolDispatchRequest) {
  const request = Object.freeze({ ...input });
  executions.add(request);
  return {
    request,
    close() {
      executions.delete(request);
    },
  };
}

export function readPreparationRequest(raw: unknown) {
  return !!raw && typeof raw === "object" && preparations.has(raw)
    ? { ok: true as const, value: raw as ToolPreparationRequest }
    : createFault("invalid-input");
}

export function readDispatchRequest(raw: unknown) {
  return !!raw && typeof raw === "object" && executions.has(raw)
    ? { ok: true as const, value: raw as ToolDispatchRequest }
    : createFault("invalid-input");
}
