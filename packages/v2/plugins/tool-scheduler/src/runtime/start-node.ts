import { createFault } from "../../../../core/src/validation";
import type { Runtime,Node } from "./types";
import { fail } from "../domain/fail";
import { recordResult } from "./record-result";
import { releaseNode } from "./release-node";
import type { ToolOutput,ToolsError } from "../../../tools/src/index";
import type { SchedulerError } from "../contracts/types";
export function startNode(runtime:Runtime,node:Node){
 const batch=node.batch;node.state="running";runtime.running++;batch.active++;runtime.toolActive.set(node.spec.name,(runtime.toolActive.get(node.spec.name)??0)+1);
 const task=batch.call.spawn<ToolOutput,SchedulerError|ToolsError>({label:"scheduled-tool",...(node.spec.timeoutMs?{timeoutMs:node.spec.timeoutMs}:{}),async run(call){const access=await call.dispatch("access",batch.access);if(!access.ok)return access.error.code==="guard-unconfigured"?fail("access-denied"):access;if(access.value.kind!=="allow")return fail("access-denied");if(call.signal.aborted)return createFault("cancelled");return call.deps.tools.execute({name:node.spec.name,callId:node.spec.callId,input:node.spec.input,...(node.spec.timeoutMs?{timeoutMs:node.spec.timeoutMs}:{}),...(batch.input.onProgress?{onProgress:(delta,signal)=>batch.input.onProgress!(Object.freeze({callId:node.spec.callId,delta}),signal)}:{})});}});
 if(!task.ok){finish(runtime,node,task);return;}node.task=task.value;
 void batch.call.wait(task.value).then(result=>{recordResult(runtime,node,result);runtime.wake();});
 void task.value.finished.then(result=>{finish(runtime,node,result);runtime.wake();});
}
function finish(runtime:Runtime,node:Node,result:Parameters<typeof recordResult>[2]){recordResult(runtime,node,result);node.actualDone=true;node.state="done";node.task=undefined;runtime.running--;node.batch.active--;const active=runtime.toolActive.get(node.spec.name)!-1;if(active)runtime.toolActive.set(node.spec.name,active);else runtime.toolActive.delete(node.spec.name);releaseNode(runtime,node);}
