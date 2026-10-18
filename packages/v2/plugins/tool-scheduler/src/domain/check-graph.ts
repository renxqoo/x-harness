import type { ScheduledCall } from "../contracts/types";
export function checkGraph(calls:readonly ScheduledCall[]):boolean{
 const byId=new Map(calls.map(call=>[call.callId,call]));if(byId.size!==calls.length)return false;const done=new Set<string>(),visiting=new Set<string>();
 const visit=(id:string):boolean=>{if(done.has(id))return true;if(visiting.has(id))return false;const call=byId.get(id);if(!call)return false;visiting.add(id);for(const parent of call.dependsOn??[])if(!visit(parent))return false;visiting.delete(id);done.add(id);return true;};return calls.every(call=>visit(call.callId));
}
