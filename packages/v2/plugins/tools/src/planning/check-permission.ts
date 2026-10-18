import {signalAborted} from "../../../../core/src/validation";
import type {Invocation} from "../../../../core/src/index";
import {preparedCells,commitCells} from "./shared";
import {checkPlan} from "./check-plan";
import {closePlan} from "./close-plan";
import {fail} from "../domain/fail";
import type {PreparedTool,ToolCommit} from "./types";
import type {ToolsResult} from "../contracts/types";
export async function checkPermission(handle:PreparedTool,call:Invocation,originId:string):Promise<ToolsResult<ToolCommit>>{const state=preparedCells.get(handle)?.current;if(!state)return checkPlan(handle) as ToolsResult<never>;if(state.originId!==originId)return fail("access-denied");const allowed=await call.dispatch("toolAccess",{operation:"execute",tool:state.entry.tool,origin:state.plan.origin,input:state.request.input,callId:state.request.callId});if(!allowed.ok){closePlan(state);return allowed as ToolsResult<never>;}if((allowed.value as {kind:string}).kind!=="allow"){closePlan(state,"access-denied");return fail("access-denied");}const status=checkPlan(handle);if(!status.ok)return status;if(signalAborted(call.signal))return fail("cancelled");const commit=Object.freeze({id:crypto.randomUUID()});commitCells.set(commit,{state:new WeakRef(state),originId});return {ok:true,value:commit};}
