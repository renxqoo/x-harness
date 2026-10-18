import type {PreparedTool,ToolExecutionPlan} from "./types";
import {checkPlan} from "./check-plan";
export function createPreparedHandle(plan:ToolExecutionPlan):PreparedTool{
 const handle:PreparedTool=Object.freeze({plan,status:()=>checkPlan(handle)});
 return handle;
}
