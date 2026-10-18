import {normalizeResources} from "./normalize-resources";
import { readJsonValue,createFault } from "../../../core/src/validation";
import type { ResourceClaim } from "./types";
export function readResources(raw:unknown){
 const parsed=readJsonValue(raw);if(!parsed.ok||!Array.isArray(parsed.value)||parsed.value.length>128)return createFault("invalid-input");const result:ResourceClaim[]=[];
 for(const item of parsed.value){if(!item||typeof item!=="object"||Array.isArray(item))return createFault("invalid-input");const d=item as Record<string,unknown>;if(Object.keys(d).some(k=>!["domain","path","scope","mode"].includes(k))||typeof d.domain!=="string"||!d.domain.length||d.domain.length>256||!Array.isArray(d.path)||d.path.length>64||d.path.some(p=>typeof p!=="string"||!p.length||p.length>1024||new TextEncoder().encode(p).length>1024||p==="."||p===".."||p.includes("\0"))||!['exact','subtree'].includes(d.scope as string)||!['read','write'].includes(d.mode as string))return createFault("invalid-input");
 const claim=d as unknown as ResourceClaim;const old=result.find(x=>x.domain===claim.domain&&x.scope===claim.scope&&JSON.stringify(x.path)===JSON.stringify(claim.path));if(old){if(claim.mode==="write")result[result.indexOf(old)]=claim;}else result.push(claim);
 }return {ok:true as const,value:normalizeResources(result)};
}
