import {signalAborted} from "../../../../core/src/validation";
import {checkPermission} from "./check-permission";
import type { Invocation } from "../../../../core/src/index";
import {createExecutionFacade} from "./create-execution-facade";
import { makeTicket,closeTicket } from "../internal";
import { readOutput } from "../domain/read-output";
import { fail } from "../domain/fail";
import { propagateCancellation } from "../execution/propagate-cancellation";
import { preparedCells,capacityCells,policyCells,commitCells } from "./shared";
import { checkPlan } from "./check-plan";
import { closePlan } from "./close-plan";
import type { PlanningRuntime } from "./state";
import type { PreparedToolRequest } from "./types";
import type { ToolsResult,ToolOutput } from "../contracts/types";
export async function runPrepared(runtime:PlanningRuntime,input:PreparedToolRequest,options:{call:Invocation;originId:string}):Promise<ToolsResult<ToolOutput>>{
 const {call,originId}=options;
 const state=preparedCells.get(input.prepared)?.current;if(!state)return checkPlan(input.prepared) as ToolsResult<never>;if(state.runtime.deref()!==runtime||state.originId!==originId)return fail("access-denied");if(input.commit){const commit=commitCells.get(input.commit);if(!commit||commit.state.deref()!==state||commit.originId!==originId)return fail("access-denied");commitCells.delete(input.commit);}else{const checked=await checkPermission(input.prepared,call,originId);if(!checked.ok)return checked;}

 const status=checkPlan(input.prepared);if(!status.ok)return status;if(signalAborted(call.signal)||input.signal&&signalAborted(input.signal)){closePlan(state,"cancelled");return fail("cancelled");}if(status.value==="waiting")return fail("resource-busy");const capacities=[...new Set(input.capacities??[])];if(capacities.some(x=>!capacityCells.has(x)))return fail("invalid-input");if(capacities.some(x=>capacityCells.get(x)!.active>=x.limit))return fail("admission-busy");if((runtime.toolActive.get(state.entry.id)??0)>=state.entry.tool.concurrency){closePlan(state);return fail("busy");}
 if(state.phase!=="pending"||signalAborted(state.entry.signal)||runtime.closed||preparedCells.get(input.prepared)?.current!==state||state.permissions.some(x=>x.signal&&signalAborted(x.signal)))return fail("closed");state.phase="running";runtime.pending.delete(input.prepared);preparedCells.get(input.prepared)!.current=undefined;policyCells.delete(state.plan);state.capacities=capacities;for(const capacity of capacities)capacityCells.get(capacity)!.active++;runtime.active.add(state);runtime.toolActive.set(state.entry.id,(runtime.toolActive.get(state.entry.id)??0)+1);
 const cancel=(reason:"cancelled"|"timeout")=>{call.cancel(reason);};let ticket:ReturnType<typeof makeTicket>|undefined;let executionCell:ReturnType<typeof createExecutionFacade>|undefined;const task=call.spawn({label:"prepared-tool",signal:input.signal,timeoutMs:Math.min(input.timeoutMs??state.request.timeoutMs??runtime.limits.timeoutMs,runtime.limits.timeoutMs),async run(child){
  executionCell=state.plan.execution?createExecutionFacade(child,state.plan.execution):undefined;const execution=executionCell?.facade;
  if(input.onStart){try{input.onStart();}catch{return fail("consumer-failed");}}ticket=makeTicket({entry:state.entry,request:{...state.request,...(input.onProgress?{onProgress:input.onProgress}:{})},caller:state.plan.origin,limits:runtime.limits,cancel,plan:state.plan,execution});const result=await child.dispatch("toolDispatch",ticket);if(!result.ok)return propagateCancellation(result,cancel) as ToolsResult<never>;return readOutput(result.value,runtime.limits.maxOutputBytes);
 }});
 if(task.ok)state.cancel=reason=>{call.cancel(reason??"cancelled");};try{return task.ok?propagateCancellation(await call.wait(task.value),cancel):task;}finally{if(task.ok)await task.value.finished;executionCell?.close();executionCell=undefined;if(ticket)closeTicket(ticket);runtime.active.delete(state);const count=runtime.toolActive.get(state.entry.id)!-1;if(count)runtime.toolActive.set(state.entry.id,count);else runtime.toolActive.delete(state.entry.id);for(const capacity of capacities)capacityCells.get(capacity)!.active--;closePlan(state);}
}
