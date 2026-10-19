import type { ValidateFunction } from "ajv";
import type { ToolDescription,ToolsResult } from "../contracts/types";
import { readDescription } from "../domain/read-description";
import { compileSchema,maximumSchemaCodeBytes } from "./compile-schema";
import { data } from "../domain/read-values";
import { fail } from "../domain/fail";
export interface CompiledDescription {readonly tool:ToolDescription;readonly input:ValidateFunction;readonly output?:ValidateFunction}
const cache=new WeakMap<object,ToolsResult<CompiledDescription>>();
export function compileDescription(raw:unknown):ToolsResult<CompiledDescription>{
 if(raw&&typeof raw==="object"){const cached=cache.get(raw);if(cached)return cached;}
 const d=data(raw);if(!d)return fail("invalid-input");const input=compileSchema(d.inputSchema);if(!input.ok)return input;const output=d.outputSchema===undefined?undefined:compileSchema(d.outputSchema);if(output&&!output.ok)return output;const described=readDescription({...d,inputSchema:input.value.schema,...(output?.ok?{outputSchema:output.value.schema}:{})});if(!described.ok)return fail("invalid-input");
 if(new TextEncoder().encode(input.value.validate.toString()+(output?.ok?output.value.validate.toString():"")).length>maximumSchemaCodeBytes)return fail("capacity-exceeded");
 const result={ok:true as const,value:Object.freeze({tool:described.value,input:input.value.validate,...(output?.ok?{output:output.value.validate}:{})})};cache.set(raw as object,result);cache.set(described.value,result);return result;
}
