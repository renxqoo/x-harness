import {createFault} from "../../../core/src/validation";
import {readResources} from "./read-resources";
import {normalizeResources} from "./normalize-resources";
export function mergeResources(left:unknown,right:unknown){const a=readResources(left),b=readResources(right);if(!a.ok||!b.ok)return createFault("invalid-input");const value=normalizeResources([...a.value,...b.value]);if(value.length>128||new TextEncoder().encode(JSON.stringify(value)).length>65536)return createFault("resource-limit");return {ok:true as const,value};}
