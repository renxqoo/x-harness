import type { LlmLimits } from "../contracts";
import { readLlmLimits } from "./read-limits";
import { readLlmRequest as readRequest } from "./read-request";
export function readLlmRequest(raw:unknown,options:Partial<LlmLimits>={}){const limits=readLlmLimits(options);return limits.ok?readRequest(raw,limits.value):limits;}
