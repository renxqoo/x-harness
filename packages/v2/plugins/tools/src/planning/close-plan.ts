import type { PlanState } from "./state";
import { preparedCells,policyCells } from "./shared";
import type { ToolsError } from "../contracts/types";
export function closePlan(state:PlanState,code:ToolsError["code"]="closed"){
 if(state.phase==="closed")return;const runtime=state.runtime.deref();state.phase="closed";const cell=preparedCells.get(state.handle)!;cell.current=undefined;cell.error={source:"tools",code,message:code};runtime?.pending.delete(state.handle);policyCells.delete(state.plan);for(const off of state.off.splice(0))off();state.permissions.length=0;const end=state.endLease;state.endLease=undefined;end?.();state.cancel=undefined;runtime?.emit();
}
