import type { CatalogEntry } from "../internal";
import { knownEntry } from "../internal";
import type { ToolsLimits,ToolsResult } from "../contracts/types";
import { fail } from "./fail";
interface Cell {current?: (entry:CatalogEntry)=>ToolsResult<void>}
function visitor(cell:Cell){return (entry:CatalogEntry):ToolsResult<void>=>cell.current?cell.current(entry):fail("closed");}
export function queryCatalog(limits:ToolsLimits){
 const entries=new Map<string,CatalogEntry>();let bytes=0;let failure:ToolsResult<never>|undefined;
 const cell:Cell={current(entry){if(failure)return failure;if(!knownEntry(entry))return failure=fail("invalid-output");if(entries.has(entry.tool.name))return failure=fail("name-conflict");if(entries.size>=limits.maxTools||bytes+entry.bytes>limits.maxCatalogBytes)return failure=fail("capacity-exceeded");entries.set(entry.tool.name,entry);bytes+=entry.bytes;return {ok:true,value:undefined};}};
 return {input:Object.freeze({visit:visitor(cell)}),finish():ToolsResult<readonly CatalogEntry[]>{cell.current=undefined;return failure??{ok:true,value:Object.freeze([...entries.values()].sort((a,b)=>a.tool.name.localeCompare(b.tool.name)))};},close(){cell.current=undefined;}};
}
