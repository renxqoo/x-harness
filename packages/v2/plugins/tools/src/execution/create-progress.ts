import type { Invocation, TaskHandle } from "../../../../core/src/index";
import type { ToolsResult,ToolsLimits,ToolRequest,ToolsError } from "../contracts/types";
import { fail } from "../domain/fail";
interface Live {call:Invocation; callback:ToolRequest["onProgress"]; limits:ToolsLimits; bytes:number; count:number; cancel:(reason:"cancelled"|"timeout")=>void; failure?:ToolsResult<never>; active?:{handle:TaskHandle<void,ToolsError>;done:Promise<void>}}
interface Cell {current?:Live}
function send(cell:Cell){return async(delta:string):Promise<ToolsResult<void>>=>{
 const state=cell.current;if(!state)return fail("closed");if(state.failure)return state.failure;if(state.active)return state.failure=fail("execution-failed");
 if(typeof delta!=="string")return state.failure=fail("invalid-output");const bytes=new TextEncoder().encode(delta).length;if(bytes>state.limits.maxProgressBytes||state.bytes+bytes>state.limits.maxProgressTotalBytes||++state.count>state.limits.maxProgressEvents)return state.failure=fail("capacity-exceeded");state.bytes+=bytes;
 const callback=state.callback;if(!callback)return {ok:true,value:undefined};
 const task=state.call.spawn<void,ToolsError>({label:"tool-progress",timeoutMs:state.limits.consumerTimeoutMs,async run(call):Promise<ToolsResult<void>>{try{await callback(delta,call.signal);return {ok:true as const,value:undefined};}catch{return fail("consumer-failed");}}});if(!task.ok)return state.failure=task;
 let tracked!:NonNullable<Live["active"]>;
 const done=task.value.finished.then(()=>{if(state.active===tracked)state.active=undefined;});
 tracked={handle:task.value,done};state.active=tracked;
 const result=await state.call.wait(task.value);
 if(!result.ok){state.failure??=result as ToolsResult<never>;if(result.error.source==="core"&&result.error.code==="timeout")state.cancel(result.error.code);}else await done;
 return result;
};}
export function createProgress(options:{call:Invocation;callback:ToolRequest["onProgress"];limits:ToolsLimits;cancel:(reason:"cancelled"|"timeout")=>void}){const {call,callback,limits,cancel}=options;const cell:Cell={current:{call,callback,limits,cancel,bytes:0,count:0}};return {send:send(cell),async finish():Promise<ToolsResult<void>>{const state=cell.current;if(!state)return fail("closed");if(state.active){state.failure??=fail("execution-failed");state.active.handle.cancel();await state.active.done;}const result=state.failure??{ok:true as const,value:undefined};cell.current=undefined;return result;},close(){cell.current=undefined;}};}
