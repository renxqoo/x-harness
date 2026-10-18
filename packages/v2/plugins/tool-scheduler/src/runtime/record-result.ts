import type { Runtime,Node } from "./types";
import type { SchedulerResult } from "../contracts/types";
import type { ToolOutput } from "../../../tools/src/index";
import { fail } from "../domain/fail";
import { stopBatch } from "./stop-batch";
export function recordResult(runtime:Runtime,node:Node,result:SchedulerResult<ToolOutput>){if(node.result)return;node.result=result;const batch=node.batch;if(batch.stopped)return;const bytes=new TextEncoder().encode(JSON.stringify({callId:node.spec.callId,result})).length+Number(batch.recorded++>0);batch.bytes+=bytes;if(batch.bytes>runtime.limits.maxResultBytes)stopBatch(runtime,batch,fail("capacity-exceeded"));}
