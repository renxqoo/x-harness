import type { JsonValue } from "../../../../core/src/index";
import type { ToolsResult } from "../contracts/types";
import { data } from "./read-values";
import { fail } from "./fail";
export function readJson(raw:unknown,limits:{readonly maxBytes:number;readonly maxNodes?:number;readonly maxDepth?:number}):ToolsResult<JsonValue>{
 const {maxBytes,maxNodes=10000,maxDepth=32}=limits;const exceeded={};
 let bytes=0,nodes=0;const path=new Set<object>();const encoder=new TextEncoder();
 const charge=(n:number)=>{bytes+=n;if(bytes>maxBytes)throw exceeded;};
 const visit=(value:unknown,depth:number):JsonValue=>{
  if(++nodes>maxNodes||depth>maxDepth)throw new TypeError();
  if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)){charge(JSON.stringify(value).length);return value;}
  if(typeof value==="string"){if(value.length>maxBytes)throw exceeded;charge(encoder.encode(JSON.stringify(value)).length);return value;}
  if(!value||typeof value!=="object"||path.has(value))throw new TypeError();path.add(value);charge(2);
  let result:JsonValue;
  if(Array.isArray(value)){
   const count=Object.getOwnPropertyDescriptor(value,"length")?.value as unknown;
   if(!Number.isSafeInteger(count)||(count as number)>maxNodes||Reflect.ownKeys(value).length!==(count as number)+1)throw new TypeError();const values:JsonValue[]=[];
   for(let i=0;i<(count as number);i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!("value"in d))throw new TypeError();if(i)charge(1);values.push(visit(d.value,depth+1));}result=Object.freeze(values);
  }else{
   const read=data(value);if(!read)throw new TypeError();const values:Record<string,JsonValue>=Object.create(null);let i=0;
   for(const [k,v] of Object.entries(read)){visit(k,depth+1);charge(1+Number(i++>0));values[k]=visit(v,depth+1);}result=Object.freeze(values);
  }
  path.delete(value);return result;
 };
 try{return {ok:true,value:visit(raw,0)};}catch(error){return fail(error===exceeded?"capacity-exceeded":"invalid-input");}
}
