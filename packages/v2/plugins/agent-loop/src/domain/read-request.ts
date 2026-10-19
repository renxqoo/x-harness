import { readLlmRequest } from "../../../llm/src/validation";
import type { LlmRequest } from "../../../llm/src/index";
import type { AgentLimits,AgentResult,AgentRunInput } from "../contracts/types";
import {data,text} from "./read-values";
import {readJson} from "./read-json";
import {fail} from "./fail";
export interface RunRequest {readonly runId:string;readonly request:Omit<LlmRequest,"tools"|"signal">;readonly metadata?:AgentRunInput["metadata"];readonly signal?:AbortSignal;readonly names?:readonly string[];readonly onEvent?:AgentRunInput["onEvent"]}
export function readRequest(raw:unknown,limits:AgentLimits):AgentResult<RunRequest>{
 const d=data(raw);if(!d||d.runId!==undefined&&!text(d.runId)||d.onEvent!==undefined&&typeof d.onEvent!=="function")return fail("invalid-input");const {runId,onEvent,tools,metadata,...fields}=d;let tags:AgentRunInput["metadata"];if(metadata!==undefined){const parsed=readJson(metadata,65536);if(!parsed.ok)return parsed;if(!data(parsed.value))return fail("invalid-input");tags=parsed.value as AgentRunInput["metadata"];}let names:readonly string[]|undefined;
 if(tools!==undefined){const read=readJson(tools,limits.maxTranscriptBytes);if(!read.ok)return read;if(!Array.isArray(read.value)||read.value.length>limits.maxTools||read.value.some(name=>!text(name,64))||new Set(read.value).size!==read.value.length)return fail("invalid-input");names=read.value as readonly string[];}
 const parsed=readLlmRequest(fields,{maxInputBytes:limits.maxTranscriptBytes,maxMessages:limits.maxMessages,maxTools:limits.maxTools});if(!parsed.ok)return fail(parsed.error.source==="llm"&&parsed.error.code==="capacity-exceeded"?"capacity-exceeded":"invalid-input");
 return {ok:true,value:Object.freeze({runId:runId as string??crypto.randomUUID(),...(tags?{metadata:tags}:{}),request:Object.freeze(Object.fromEntries(Object.entries(parsed.value).filter(([key])=>key!=="signal"))) as unknown as LlmRequest,...(parsed.value.signal?{signal:parsed.value.signal}:{}),...(names?{names}:{}),...(onEvent?{onEvent:onEvent as AgentRunInput["onEvent"]}:{})})};
}
