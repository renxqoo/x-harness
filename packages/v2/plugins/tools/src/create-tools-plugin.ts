import {watchRuntime} from "./planning/watch-runtime";
import {observeSignal,signalAborted} from "../../../core/src/validation";
import {checkPermission} from "./planning/check-permission";
import { execution } from "../../execution/src/index";
import { prepareTool } from "./planning/prepare-tool";
import { runPrepared } from "./planning/run-prepared";
import { readPreparedRequest } from "./planning/read-prepared-request";
import { preparedCells,readPreparedTool } from "./planning/shared";
import { closePlan } from "./planning/close-plan";
import type { PlanningRuntime } from "./planning/state";
import { definePlugin } from "../../../core/src/index";
import type { Plugin,Invocation } from "../../../core/src/index";
import type { ToolsOptions,ToolsResult,ToolDescription } from "./contracts/types";
import { tools,toolAccess,toolExecutionAccess,toolAvailability } from "./contracts";
import { toolCatalog,toolDispatch,toolPreparation } from "./internal";
import { propagateCancellation } from "./execution/propagate-cancellation";
import { queryCatalog } from "./domain/query-catalog";
import { readLimits } from "./domain/read-limits";
import { readRequest } from "./domain/read-request";
import { data,keys,name } from "./domain/read-values";
import { fail } from "./domain/fail";
export function createToolsPlugin(raw:ToolsOptions={}):ToolsResult<Plugin>{
 const d=data(raw);if(!d||!keys(d,["access","limits"])||d.access!==undefined&&!["allow","required"].includes(d.access as string))return fail("invalid-input");const limits=readLimits(d.limits);if(!limits.ok)return limits;
 return {ok:true,value:definePlugin({name:"tools",provides:{tools,toolAccess,toolExecutionAccess,toolAvailability,toolCatalog,toolDispatch,toolPreparation},optional:{execution},setup(ctx){let active=0;
  const runtime:PlanningRuntime={closed:false,limits:limits.value,pending:new Set(),listeners:new Set(),watches:new Set(),active:new Set(),toolActive:new Map(),emit(){for(const listener of runtime.listeners){try{listener();}catch{}}ctx.emit("toolAvailability",null);},discover:call=>discover(call),lease(state){return ctx.startTask<void>({label:"prepared-tool-lease",timeoutMs:state.leaseTimeoutMs,async run(call){if(state.phase==="closed")return {ok:true,value:undefined};await new Promise<void>(resolve=>{const abort=()=>{if(state.phase==="running")state.cancel?.("timeout");else closePlan(state,"timeout");resolve();};state.endLease=resolve;state.off.push(observeSignal(call.signal,abort));if(signalAborted(call.signal))abort();});return {ok:true,value:undefined};}});}};
  const cleanup=ctx.addCleanup(()=>{runtime.closed=true;for(const close of runtime.watches)close();for(const handle of runtime.pending){const state=preparedCells.get(handle)?.current;if(state)closePlan(state);}for(const state of runtime.active)state.cancel?.();return {ok:true,value:undefined};});if(!cleanup.ok)return cleanup;
  const policy=ctx.guard("toolExecutionAccess",()=>({ok:true,value:{kind:"allow"}}));if(!policy.ok)return policy;
  const preparation=ctx.handle("toolPreparation",()=>fail("not-found"));if(!preparation.ok)return preparation;
  if(d.access==="allow"){const allow=ctx.guard("toolAccess",()=>({ok:true,value:{kind:"allow"}}));if(!allow.ok)return allow;}
  const catalog=ctx.handle("toolCatalog",()=>({ok:true,value:undefined}));if(!catalog.ok)return catalog;const terminal=ctx.handle("toolDispatch",()=>fail("not-found"));if(!terminal.ok)return terminal;
  const discover=async(call:Invocation)=>{const query=queryCatalog(limits.value);try{const result=await call.dispatch("toolCatalog",query.input);if(!result.ok)return result as ToolsResult<never>;return query.finish();}finally{query.close();}};
  const visible=async(raw:unknown,operation:"list"|"get",call:Invocation):Promise<ToolsResult<readonly ToolDescription[]>>=>{const d=data(raw);if(!d||!keys(d,operation==="list"?[]:["name"])||operation==="get"&&!name(d.name))return fail("invalid-input");const catalog=await discover(call);if(!catalog.ok)return catalog;const found:ToolDescription[]=[];
   for(const entry of catalog.value){if(operation==="get"&&entry.tool.name!==d.name)continue;const allowed=await call.dispatch("toolAccess",{operation,tool:entry.tool,origin:call.origin});if(!allowed.ok){if(allowed.error&&typeof allowed.error==="object"&&"code"in allowed.error&&allowed.error.code==="guard-unconfigured")continue;return allowed as ToolsResult<never>;}if((allowed.value as {kind:string}).kind==="allow")found.push(entry.tool);}return {ok:true,value:Object.freeze(found)};};
  return ctx.service({tools:{
   list:(input,call)=>visible(input,"list",call as Invocation),
   async get(input,call){const result=await visible(input,"get",call as Invocation);return result.ok?{ok:true,value:result.value[0]??null}:result;},
   async watch(raw,call){const d=data(raw);if(!d||!keys(d,["onChange"])||typeof d.onChange!=="function")return fail("invalid-input");return watchRuntime(runtime,{listener:d.onChange as ()=>void,signal:call.originSignal});},
   async checkPrepared(raw,call){const d=data(raw);if(!d||!keys(d,["prepared"])||!readPreparedTool(d.prepared).ok)return fail("invalid-input");if(active>=limits.value.maxActiveRequests)return fail("admission-busy");active++;const task=call.spawn({label:"tool-check",run:child=>checkPermission(d.prepared as import("./planning/types").PreparedTool,child as Invocation,call.originId)});if(!task.ok){active--;return task;}try{return await call.wait(task.value);}finally{await task.value.finished;active--;runtime.emit();}} ,
   async prepare(raw,call){const input=readRequest(raw,limits.value.maxInputBytes);if(!input.ok)return input;if(active>=limits.value.maxActiveRequests)return fail("admission-busy");active++;const task=call.spawn({label:"tool-prepare",signal:input.value.signal,timeoutMs:Math.min(input.value.timeoutMs??limits.value.timeoutMs,limits.value.timeoutMs),run:child=>prepareTool(runtime,input.value,{call:child as Invocation,source:call,leased:true})});if(!task.ok){active--;return task;}try{return await call.wait(task.value);}finally{await task.value.finished;active--;runtime.emit();}} ,
   async discard(raw,call){const d=data(raw);if(!d||!keys(d,["prepared"])||!readPreparedTool(d.prepared).ok)return fail("invalid-input");const state=preparedCells.get(d.prepared as import("./planning/types").PreparedTool)?.current;if(state){if(state.runtime.deref()!==runtime||state.originId!==call.originId)return fail("access-denied");closePlan(state);}return {ok:true,value:undefined};},
   async executePrepared(raw,call){const input=readPreparedRequest(raw);if(!input.ok)return input;if(active>=limits.value.maxActiveRequests)return fail("admission-busy");active++;const task=call.spawn({label:"tools-request",signal:input.value.signal,timeoutMs:Math.min(input.value.timeoutMs??limits.value.timeoutMs,limits.value.timeoutMs),run:child=>runPrepared(runtime,input.value,{call:child as Invocation,originId:call.originId})});if(!task.ok){active--;return task;}try{return propagateCancellation(await call.wait(task.value),reason=>{call.cancel(reason);});}finally{await task.value.finished;active--;runtime.emit();}},
   async execute(raw,call){const input=readRequest(raw,limits.value.maxInputBytes);if(!input.ok)return input;if(active>=limits.value.maxActiveRequests)return fail("busy");active++;const cancel=(reason:"cancelled"|"timeout")=>{call.cancel(reason);};let handle:import("./planning/types").PreparedTool|undefined;
    const task=call.spawn({label:"tools-request",signal:input.value.signal,timeoutMs:Math.min(input.value.timeoutMs??limits.value.timeoutMs,limits.value.timeoutMs),async run(child){const prepared=await prepareTool(runtime,input.value,{call:child as Invocation,source:call,leased:false});if(!prepared.ok)return prepared;handle=prepared.value;const result=await runPrepared(runtime,{prepared:handle},{call:child as Invocation,originId:call.originId});return !result.ok&&result.error.source==="tools"&&result.error.code==="resource-busy"?fail("busy"):result;}});
    if(!task.ok){active--;return task;}try{return propagateCancellation(await call.wait(task.value),cancel);}finally{await task.value.finished;if(handle){const state=preparedCells.get(handle)?.current;if(state)closePlan(state);}active--;runtime.emit();}
   },
  }});
 }})};
}
