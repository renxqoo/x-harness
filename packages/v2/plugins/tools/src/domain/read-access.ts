import { createFault } from "../../../../core/src/validation";
import type { ToolAccess } from "../contracts/types";
import { data,keys,object } from "./read-values";
import { readDescription } from "./read-description";
import { readJson } from "./read-json";
import { maximumToolsLimits } from "./read-limits";
export function readAccess(raw:unknown){
 const d=data(raw);if(!d||!keys(d,["operation","tool","origin","input","callId"])||!["list","get","execute"].includes(d.operation as string))return createFault("invalid-input");
 const tool=readDescription(d.tool),origin=data(d.origin);if(!tool.ok||!origin||!keys(origin,["scopeId","pluginName"])||typeof origin.scopeId!=="string"||origin.scopeId.length>160||origin.pluginName!==undefined&&(typeof origin.pluginName!=="string"||origin.pluginName.length>160))return createFault("invalid-input");
 const input=d.operation==="execute"?readJson(d.input,{maxBytes:maximumToolsLimits.maxInputBytes}):undefined;
 if(d.operation==="execute"?(!input?.ok||!object(input.value)||typeof d.callId!=="string"||!d.callId.length||d.callId.length>256):d.input!==undefined||d.callId!==undefined)return createFault("invalid-input");
 return {ok:true as const,value:Object.freeze({operation:d.operation,tool:tool.value,origin:Object.freeze(origin),...(input?.ok?{input:input.value,callId:d.callId}:{})}) as unknown as ToolAccess};
}
