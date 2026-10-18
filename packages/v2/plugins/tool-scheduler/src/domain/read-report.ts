import { createFault,normalizeResult } from "../../../../core/src/validation";
import { readToolOutput,readToolJson } from "../../../tools/src/validation";
import type { Result } from "../../../../core/src/index";
import type { BatchReport,SchedulerResult } from "../contracts/types";
import type { ToolOutput } from "../../../tools/src/index";
import { data,keys,id } from "./read-values";
import { readFailure } from "./read-failure";
export function readReport(raw:unknown):Result<BatchReport>{const parsed=readToolJson(raw,{maxBytes:16777216,maxNodes:2600000,maxDepth:40});if(!parsed.ok)return createFault("invalid-result");const d=data(parsed.value);if(!d||!keys(d,["results"])||!Array.isArray(d.results)||d.results.length>256)return createFault("invalid-result");const results:BatchReport["results"][number][]=[];const seen=new Set<string>();
 for(let i=0;i<d.results.length;i++){const descriptor=Object.getOwnPropertyDescriptor(d.results,String(i));const entry=descriptor&&"value"in descriptor?data(descriptor.value):undefined;if(!entry||!keys(entry,["callId","result"])||!id(entry.callId)||seen.has(entry.callId))return createFault("invalid-result");seen.add(entry.callId);const result=normalizeResult(entry.result);let checked:SchedulerResult<ToolOutput>;
  if(result.ok){const output=readToolOutput(result.value,4194304);if(!output.ok)return createFault("invalid-result");checked=output;}else{const error=data(result.error);if(error?.source==="core")checked=result as SchedulerResult<never>;else{const read=readFailure(result.error);if(!read.ok)return read;checked={ok:false,error:read.value};}}results.push(Object.freeze({callId:entry.callId,result:checked}));
 }return {ok:true,value:Object.freeze({results:Object.freeze(results)})};}
