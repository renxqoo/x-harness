import type { ToolContribution } from "./types";
import type { CompiledDescription } from "../schema/compile-description";
import type { ToolsLimits,ToolsResult } from "../contracts/types";
import { compileDescription } from "../schema/compile-description";
import { describeContribution } from "./describe-contribution";
import { observeSignal,signalAborted } from "../../../../core/src/validation";
import { data,keys } from "../domain/read-values";
import { fail } from "../domain/fail";
export interface CatalogEntry extends ToolContribution {readonly id:string;readonly bytes:number;readonly compiled:CompiledDescription;readonly limits:ToolsLimits}
const cache=new WeakMap<object,CatalogEntry>();
const owners=new WeakMap<AbortSignal,Map<string,{readonly signature:string;readonly entry:CatalogEntry}>>();
export function readContribution(raw:unknown):ToolsResult<CatalogEntry>{
 if(raw&&typeof raw==="object"){const cached=cache.get(raw);if(cached)return signalAborted(cached.signal)?fail("stale-plan"):{ok:true,value:cached};}
 const d=data(raw);if(!d||!keys(d,["signal","tool","limits"]))return fail("invalid-output");
 try{Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!.call(d.signal);}catch{return fail("invalid-output");}
 const signal=d.signal as AbortSignal;const described=describeContribution(d.tool,d.limits);if(!described.ok)return described;if(signalAborted(signal))return fail("stale-plan");
 let registered=owners.get(signal);if(!registered){registered=new Map();owners.set(signal,registered);const entries=registered;observeSignal(signal,()=>{entries.clear();owners.delete(signal);});}
 const previous=registered.get(described.value.tool.name);if(previous){if(previous.signature!==described.value.signature)return fail("name-conflict");cache.set(raw as object,previous.entry);return {ok:true,value:previous.entry};}
 if(registered.size>=128)return fail("capacity-exceeded");const compiled=compileDescription(described.value.tool);if(!compiled.ok)return compiled;
 const entry=Object.freeze({id:crypto.randomUUID(),signal,tool:compiled.value.tool,limits:described.value.limits,compiled:compiled.value,bytes:new TextEncoder().encode(JSON.stringify(compiled.value.tool)).length});registered.set(entry.tool.name,{signature:described.value.signature,entry});cache.set(raw as object,entry);return {ok:true,value:entry};
}
