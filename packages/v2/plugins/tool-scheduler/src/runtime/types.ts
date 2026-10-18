import type { PluginInvocation,TaskHandle } from "../../../../core/src/index";
import type { tools,ToolOutput } from "../../../tools/src/index";
import type { toolScheduleAccess } from "../contracts";
import type { Request } from "../domain/read-request";
import type { BatchReport,ScheduleAccess,SchedulerLimits,SchedulerResult,ScheduledCall } from "../contracts/types";
export type SchedulerCall=PluginInvocation<{requires:{tools:typeof tools};provides:{access:typeof toolScheduleAccess}}>;
export interface Node { readonly spec:ScheduledCall; readonly batch:Batch; readonly index:number; readonly parents:Node[]; capacity:number; state:"pending"|"running"|"done"; released:boolean; actualDone:boolean; result?:SchedulerResult<ToolOutput>; task?:TaskHandle<ToolOutput,import("../contracts/types").SchedulerError|import("../../../tools/src/index").ToolsError> }
export interface Batch { readonly input:Request; readonly access:ScheduleAccess; readonly call:SchedulerCall; readonly lane:string; readonly nodes:Node[]; active:number; bytes:number; recorded:number; stopped:boolean; error?:SchedulerResult<never>; resolve(result:SchedulerResult<BatchReport>):void; off():void }
export interface Runtime { wake():void; readonly limits:SchedulerLimits; readonly batches:Set<Batch>; queue:Node[]; readonly lanes:string[]; readonly streak:Map<string,number>; readonly toolActive:Map<string,number>; running:number; outstanding:number; requests:number; pumping:boolean; closed:boolean }

