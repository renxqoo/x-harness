import {createFault} from "../../../../core/src/validation";
import type {AgentResult} from "./types";
export function validate<T>(read:(raw:unknown)=>AgentResult<T>){return (raw:unknown)=>{const result=read(raw);return result.ok?result:createFault("invalid-input");};}
