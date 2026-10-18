import type { Batch,Runtime } from "./types";
import type { SchedulerResult } from "../contracts/types";
import { createFault } from "../../../../core/src/validation";
import { releaseNode } from "./release-node";
export function stopBatch(runtime:Runtime,batch:Batch,result:SchedulerResult<never>){if(batch.stopped)return;batch.stopped=true;batch.error=result;runtime.queue=runtime.queue.filter(node=>node.batch!==batch);for(const node of batch.nodes){if(node.state==="pending"){node.state="done";node.result=createFault("cancelled");node.actualDone=true;releaseNode(runtime,node);}else if(node.state==="running")node.task?.cancel();}batch.resolve(result);}
