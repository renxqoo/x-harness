import type {AgentCheckpoint} from "../contracts/types";
import {readLlmRunOutput} from "../../../llm/src/validation";
import {maximumAgentLimits as limits} from "./read-limits";
import {readJson} from "./read-json";
import {data,keys} from "./read-values";
import {fail} from "./fail";
import {readContext} from "./read-context";
import {readModelRequest} from "./read-model-request";
import {readReceipts} from "./read-receipts";
import {mapReceipts} from "./map-receipts";
import {mapResponse} from "./map-response";
import {equalJson} from "./equal-json";
export function readCheckpoint(raw:unknown){const read=readJson(raw,limits.maxTranscriptBytes*3);if(!read.ok)return read;const d=data(read.value);if(!d||!keys(d,["runId","step","caller","metadata","request","phase","response","messages","results"])||!["response","tools"].includes(d.phase as string)||!Array.isArray(d.messages))return fail("invalid-input");const base=readContext({runId:d.runId,step:d.step,caller:d.caller,request:d.request,...(d.metadata!==undefined?{metadata:d.metadata}:{})});const response=data(d.response);if(!base.ok||!response)return fail("invalid-input");const {content,output,...summary}=response;const checked=readLlmRunOutput({summary,content,...(output!==undefined?{output}:{})});if(!checked.ok||!checked.value.content)return fail("invalid-input");
 const last=data(d.messages.at(-1));const pending=d.phase==="response"&&last?.role==="assistant"&&Array.isArray(last.content)?last.content.flatMap(block=>{const v=data(block);return v?.type==="tool-call"?[{role:"tool",callId:v.callId,content:[{type:"text",text:""}]}]:[];}):[];
 if(!readModelRequest({model:base.value.request.model,messages:[...d.messages,...pending]}).ok)return fail("invalid-input");
 if(d.phase==="response"){if(d.results!==undefined)return fail("invalid-input");}else{const receipts=readReceipts(d.results);const mapped=mapResponse({...checked.value.summary,content:checked.value.content});if(!receipts.ok||!mapped.ok||!mapped.value.calls.length||receipts.value.length!==mapped.value.calls.length||receipts.value.some((receipt,index)=>receipt.callId!==mapped.value.calls[index]!.callId)||!equalJson(d.messages.slice(-receipts.value.length),mapReceipts(receipts.value))||!equalJson(d.messages.at(-receipts.value.length-1),mapped.value.message))return fail("invalid-input");}
 return {ok:true as const,value:read.value as unknown as AgentCheckpoint};
}
