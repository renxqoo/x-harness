import type { ToolRequest,ToolsResult } from "../contracts/types";
import { maximumToolsLimits } from "./read-limits";
import { data,keys,name,object } from "./read-values";
import { readJson } from "./read-json";
import { fail } from "./fail";
export function readRequest(raw:unknown,maxBytes:number):ToolsResult<ToolRequest>{
 const d=data(raw);if(!d||!keys(d,["name","callId","input","signal","timeoutMs","onProgress"])||!name(d.name)||typeof d.callId!=="string"||!d.callId.length||d.callId.length>256||d.onProgress!==undefined&&typeof d.onProgress!=="function"||d.timeoutMs!==undefined&&(!Number.isSafeInteger(d.timeoutMs)||(d.timeoutMs as number)<1||(d.timeoutMs as number)>maximumToolsLimits.timeoutMs))return fail("invalid-input");
 if(d.signal!==undefined){try{Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!.call(d.signal);}catch{return fail("invalid-input");}}
 const input=readJson(d.input,{maxBytes});if(!input.ok)return input;if(!object(input.value))return fail("invalid-input");return {ok:true,value:Object.freeze({...d,input:input.value}) as unknown as ToolRequest};
}
