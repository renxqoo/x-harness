import type { Node,Runtime } from "./types";
function ready(runtime:Runtime,node:Node){return !node.batch.stopped&&node.batch.active<node.batch.input.concurrency&&(runtime.toolActive.get(node.spec.name)??0)<node.capacity&&node.parents.every(parent=>{return parent.actualDone&&parent.result?.ok&&!parent.result.value.isError;});}
export function selectNode(runtime:Runtime):Node|undefined{
 for(let i=0,count=runtime.lanes.length;i<count;i++){const lane=runtime.lanes.shift()!;const all=runtime.queue.filter(node=>node.batch.lane===lane);if(!all.length){runtime.streak.delete(lane);continue;}runtime.lanes.push(lane);const eligible=all.filter(node=>ready(runtime,node));if(!eligible.length)continue;const streak=runtime.streak.get(lane)??0;const node=streak>=3?eligible[0]!:eligible.reduce((best,n)=>(n.spec.priority??0)>(best.spec.priority??0)?n:best);runtime.streak.set(lane,streak>=3?0:streak+1);return node;
 }return undefined;
}
