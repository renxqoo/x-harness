import type { Origin,OwnerInspection,PluginInvocation,TokenMap,Result } from "../../../../core/src/index";
import type { ResourceClaim,ExecutionRequest,ExecutionTarget,ExecutionFacade } from "../../../execution/src/index";
import type { JsonObject,ToolDescription,ToolRequest,ToolsResult } from "../contracts/types";
export interface ToolEffects {readonly actions?:JsonObject;readonly resources?:readonly ResourceClaim[];readonly execution?:ExecutionRequest}
export interface ToolExecutionPlan {readonly id:string;readonly callId:string;readonly tool:ToolDescription;readonly installation:string;readonly input:JsonObject;readonly origin:Origin;readonly originId:string;readonly initiator:OwnerInspection;readonly actions:JsonObject;readonly resources:readonly ResourceClaim[];readonly execution?:ExecutionTarget}
export interface PreparedTool {readonly plan:ToolExecutionPlan;status():ToolsResult<"ready"|"waiting">}
export interface ToolCapacity {readonly limit:number;readonly active:number}
export interface ToolCommit {readonly id:string}
export interface PreparedToolRequest {readonly commit?:ToolCommit;readonly prepared:PreparedTool;readonly signal?:AbortSignal;readonly timeoutMs?:number;readonly onProgress?:ToolRequest["onProgress"];readonly capacities?:readonly ToolCapacity[];readonly onStart?:()=>void}
export type ToolPermission={readonly kind:"allow";readonly isValid?:()=>boolean;readonly signal?:AbortSignal}|{readonly kind:"deny"};
export interface ToolPolicyOptions<D extends TokenMap=Record<never,never>,O extends TokenMap=Record<never,never>> {readonly name:string;readonly requires?:D;readonly optional?:O;readonly authorize:(plan:ToolExecutionPlan,call:PluginInvocation<{requires:D;optional:O}>)=>Result<ToolPermission>|Promise<Result<ToolPermission>>}
export type ToolPreparationInvocation<D extends TokenMap=Record<never,never>,O extends TokenMap=Record<never,never>>=PluginInvocation<{requires:D;optional:O}> & {readonly callId:string;readonly name:string;readonly caller:Origin};
export type ToolExecutionContext={readonly plan:ToolExecutionPlan;readonly execution?:ExecutionFacade};
