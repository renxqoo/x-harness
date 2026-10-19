import type { ToolCapacity,ToolCommit,PreparedTool } from "./types";
import type { PlanState } from "./state";
import type { ToolsError } from "../contracts/types";
import { createFault } from "../../../../core/src/validation";
export const preparedCells=new WeakMap<PreparedTool,{current?:PlanState;error?:ToolsError}>();
export const capacityCells=new WeakMap<ToolCapacity,{active:number}>();
export function createToolCapacity(limit:number){if(!Number.isSafeInteger(limit)||limit<1||limit>1024)return createFault("invalid-input");const state={active:0};const value=Object.freeze({limit,get active(){return state.active;}});capacityCells.set(value,state);return {ok:true as const,value};}
export function readPreparedTool(raw:unknown){return !!raw&&typeof raw==="object"&&preparedCells.has(raw as PreparedTool)?{ok:true as const,value:raw as PreparedTool}:createFault("invalid-input");}

export const commitCells=new WeakMap<ToolCommit,{state:WeakRef<PlanState>;originId:string}>();
export function readToolCommit(raw:unknown){return !!raw&&typeof raw==="object"&&commitCells.has(raw as ToolCommit)?{ok:true as const,value:raw as ToolCommit}:createFault("invalid-input");}

export const authorizationRequests=new WeakSet<object>();
export const preparationRequests=new WeakSet<object>();
export const dispatchRequests=new WeakSet<object>();
