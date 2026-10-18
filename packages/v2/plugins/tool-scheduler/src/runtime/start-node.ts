import { createFault } from "../../../../core/src/validation";
import type { Runtime,Node } from "./types";
import { fail } from "../domain/fail";
import { recordResult } from "./record-result";
import { releaseNode } from "./release-node";
import type { ToolOutput,ToolsError } from "../../../tools/src/index";
import type { SchedulerError,SchedulerResult } from "../contracts/types";
function isWaiting(node:Node){const status=node.prepared?.status();return status?.ok&&status.value==="waiting";}
function retry(result:SchedulerResult<ToolOutput>){return !result.ok&&result.error.source==="tools"&&["resource-busy","admission-busy"].includes(result.error.code);}
export function startNode(runtime:Runtime,node:Node){
 const batch=node.batch,attemptRevision=runtime.revision;let phase:"prepare"|"check"|"commit"="commit";if(!node.prepared)phase="prepare";else if(!node.commit)phase="check";node.state=phase==="commit"?"committing":"checking";if(phase==="commit")runtime.committing++;else runtime.checking++;
 const task=batch.call.spawn<ToolOutput,SchedulerError|ToolsError>({label:"scheduled-tool",...(node.spec.timeoutMs?{timeoutMs:node.spec.timeoutMs}:{}),async run(call){
  if(phase!=="commit"){const access=await call.dispatch("access",batch.access);if(!access.ok)return access.error.code==="guard-unconfigured"?fail("access-denied"):access;if(access.value.kind!=="allow")return fail("access-denied");if(call.signal.aborted)return createFault("cancelled");}
  if(phase==="prepare"){const prepared=await call.deps.tools.prepare({name:node.spec.name,callId:node.spec.callId,input:node.spec.input,signal:batch.controller.signal,...(node.spec.timeoutMs?{timeoutMs:node.spec.timeoutMs}:{})});if(!prepared.ok)return prepared;node.prepared=prepared.value;return {ok:true,value:{content:[]}};}
  if(phase==="check"){const commit=await call.deps.tools.checkPrepared({prepared:node.prepared!});if(!commit.ok)return commit;node.commit=commit.value;return {ok:true,value:{content:[]}};}
  if(batch.stopped||call.signal.aborted)return createFault("cancelled");return call.deps.tools.executePrepared({prepared:node.prepared!,commit:node.commit!,signal:call.signal,capacities:[runtime.capacity,batch.capacity],...(node.spec.timeoutMs?{timeoutMs:node.spec.timeoutMs}:{}),onStart(){node.state="running";runtime.committing--;runtime.running++;batch.active++;const streak=runtime.streak.get(batch.lane)??0;runtime.streak.set(batch.lane,streak>=3?0:streak+1);const index=runtime.lanes.indexOf(batch.lane);if(index>=0)runtime.lanes.splice(index,1);runtime.lanes.push(batch.lane);runtime.toolActive.set(node.spec.name,(runtime.toolActive.get(node.spec.name)??0)+1);runtime.wake();},...(batch.input.onProgress?{onProgress:(delta,signal)=>batch.input.onProgress!(Object.freeze({callId:node.spec.callId,delta}),signal)}:{})});}});
 if(!task.ok){finish(runtime,node,{result:task,phase,attemptRevision});return;}node.task=task.value;
 void batch.call.wait(task.value).then(result=>{if(!retry(result)&&!(phase!=="commit"&&result.ok))recordResult(runtime,node,result);runtime.wake();});
 void task.value.finished.then(result=>{finish(runtime,node,{result,phase,attemptRevision});runtime.wake();});
}
function finish(runtime:Runtime,node:Node,options:{result:Parameters<typeof recordResult>[2];phase:"prepare"|"check"|"commit";attemptRevision:number}){let {result}=options;const {phase}=options;if(node.state==="running"){runtime.running--;node.batch.active--;const active=runtime.toolActive.get(node.spec.name)!-1;if(active)runtime.toolActive.set(node.spec.name,active);else runtime.toolActive.delete(node.spec.name);}else if(node.state==="committing")runtime.committing--;else runtime.checking--;node.task=undefined;
 if(node.batch.input.mode==="immediate"&&!node.batch.stopped&&(retry(result)||phase!=="commit"&&result.ok&&isWaiting(node)))result=fail("busy");
 if((retry(result)||phase!=="commit"&&result.ok)&&!node.batch.stopped){if(retry(result)){node.commit=undefined;node.blockedRevision=options.attemptRevision;}else node.blockedRevision=undefined;node.state="pending";if(!runtime.lanes.includes(node.batch.lane))runtime.lanes.push(node.batch.lane);runtime.queue.push(node);runtime.queue.sort((a,b)=>a.order-b.order);return;}
 recordResult(runtime,node,result);node.actualDone=true;node.state="done";if(node.prepared){void node.batch.call.deps.tools.discard({prepared:node.prepared});node.prepared=undefined;}node.commit=undefined;releaseNode(runtime,node);
}
