import type { Batch } from "./types";
export function completeBatch(batch:Batch){if(batch.stopped||batch.nodes.some(node=>!node.actualDone))return;batch.stopped=true;batch.resolve({ok:true,value:Object.freeze({results:Object.freeze(batch.nodes.map(node=>Object.freeze({callId:node.spec.callId,result:node.result!})))})});}
