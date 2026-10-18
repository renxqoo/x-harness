import {signalAborted} from "../../../../core/src/validation";
import type { PreparedTool } from "./types";
import { preparedCells } from "./shared";
import { conflicts } from "./conflicts";
import { closePlan } from "./close-plan";
import { fail } from "../domain/fail";
export function checkPlan(handle:PreparedTool){
 const cell=preparedCells.get(handle),state=cell?.current;if(!state)return cell?.error?{ok:false as const,error:cell.error}:fail("closed");const runtime=state.runtime.deref();if(!runtime||runtime.closed){closePlan(state);return fail("closed");}if(state.phase!=="pending")return fail("closed");if(signalAborted(state.entry.signal)){closePlan(state,"stale-plan");return fail("stale-plan");}
 let allowed=true;try{for(const permission of state.permissions)if(permission.signal&&signalAborted(permission.signal)||permission.isValid&&permission.isValid()!==true){allowed=false;break;}}catch{allowed=false;}if(!allowed){closePlan(state,"access-denied");return fail("access-denied");}if(cell!.current!==state||state.phase!=="pending"||runtime.closed||signalAborted(state.entry.signal))return fail("closed");
 for(const active of runtime.active)if(conflicts(state.plan.resources,active.plan.resources))return {ok:true as const,value:"waiting" as const};
 for(const earlier of runtime.pending){if(earlier===handle)break;const old=preparedCells.get(earlier)?.current;if(old?.phase==="pending"&&conflicts(state.plan.resources,old.plan.resources))return {ok:true as const,value:"waiting" as const};}
 return {ok:true as const,value:"ready" as const};
}
