import type { Origin } from "../../../../core/src/index";
import type { ExecutionFacade } from "../../../execution/src/index";
import type { ToolDescription,ToolExecutionLimits,JsonObject,ToolsResult } from "../contracts/types";
import type { ToolExecutionPlan } from "../planning/types";
export interface ToolContribution {readonly signal:AbortSignal;readonly tool:ToolDescription;readonly limits?:Partial<ToolExecutionLimits>}
export interface ToolCatalogQuery {readonly visit:(entry:ToolContribution)=>ToolsResult<void>}
export interface ToolPreparationRequest {readonly ownerSignal:AbortSignal;readonly name:string;readonly callId:string;readonly input:JsonObject;readonly caller:Origin}
export interface ToolDispatchRequest extends ToolPreparationRequest {readonly plan:ToolExecutionPlan;readonly progress:(delta:string)=>Promise<ToolsResult<void>>;readonly execution?:ExecutionFacade}
