import { readToolJson } from "../../../tools/src/validation";
import { fail } from "./fail";
export function readJson(raw:unknown,maxBytes:number){const read=readToolJson(raw,{maxBytes,maxDepth:64,maxNodes:200000});return read.ok?read:fail(read.error.source==="tools"&&read.error.code==="capacity-exceeded"?"capacity-exceeded":"invalid-input");}
