import type { BatchRequest, ScheduledCall, SchedulerLimits,SchedulerResult } from "../contracts/types";
import { data,keys,integer } from "./read-values";
import { readCalls } from "./read-calls";
import { fail } from "./fail";
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!;
export interface Request { readonly operation:"execute"|"batch"; readonly calls:readonly ScheduledCall[]; readonly concurrency:number; readonly timeoutMs:number; readonly signal?:AbortSignal; readonly mode:"wait"|"immediate"; readonly onProgress?:BatchRequest["onProgress"] }
export function readRequest(raw:unknown,batch:boolean,limits:SchedulerLimits):SchedulerResult<Request>{
 const d=data(raw);const allowed=batch?["calls","concurrency","signal","timeoutMs","onProgress"]:["name","callId","input","priority","mode","signal","timeoutMs","onProgress"];if(!d||!keys(d,allowed)||d.onProgress!==undefined&&typeof d.onProgress!=="function"||d.timeoutMs!==undefined&&!integer(d.timeoutMs,1,1800000)||d.concurrency!==undefined&&!integer(d.concurrency,1,limits.concurrency)||d.mode!==undefined&&!['wait','immediate'].includes(d.mode as string))return fail("invalid-input");
 if(d.signal!==undefined){try{aborted.get!.call(d.signal);}catch{return fail("invalid-input");}}
 const single={name:d.name,callId:d.callId,input:d.input,...(d.priority!==undefined?{priority:d.priority}:{})};const calls=readCalls(batch?d.calls:[single],limits);if(!calls.ok)return calls;const callback=d.onProgress as ((delta:string,signal:AbortSignal)=>void|Promise<void>)|undefined;
 let onProgress=d.onProgress as BatchRequest["onProgress"];if(!batch)onProgress=callback?(event,signal)=>callback(event.delta,signal):undefined;
 return {ok:true,value:Object.freeze({operation:batch?"batch":"execute",calls:calls.value,concurrency:batch?(d.concurrency as number|undefined)??limits.concurrency:1,timeoutMs:Math.min((d.timeoutMs as number|undefined)??limits.timeoutMs,limits.timeoutMs),signal:d.signal as AbortSignal|undefined,mode:(d.mode as "wait"|"immediate"|undefined)??"wait",onProgress})};
}
