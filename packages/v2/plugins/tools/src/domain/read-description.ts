import { createFault } from "../../../../core/src/validation";
import type { ToolDescription } from "../contracts/types";
import { data,keys,name } from "./read-values";
import { readSchema } from "../schema/read-schema";
const known=new WeakSet<object>();
export function readDescription(raw:unknown){
 if(raw&&typeof raw==="object"&&known.has(raw))return {ok:true as const,value:raw as ToolDescription};
 const d=data(raw);if(!d||!keys(d,["name","description","inputSchema","outputSchema","concurrency"])||!name(d.name)||d.description!==undefined&&(typeof d.description!=="string"||d.description.length>8192)||!Number.isSafeInteger(d.concurrency)||(d.concurrency as number)<1||(d.concurrency as number)>256)return createFault("invalid-result");
 const input=readSchema(d.inputSchema),output=d.outputSchema===undefined?undefined:readSchema(d.outputSchema);if(!input.ok||output&&!output.ok)return createFault("invalid-result");
 const value=Object.freeze({...d,inputSchema:input.value,...(output?.ok?{outputSchema:output.value}:{})}) as unknown as ToolDescription;known.add(value);return {ok:true as const,value};
}
