import { defineService,defineGuard } from "../../../../core/src/index";
import { createFault } from "../../../../core/src/validation";
import type { ToolsService,ToolAccess,ToolDescription } from "./types";
import { readError } from "../domain/read-error";
import { readOutput } from "../domain/read-output";
import { readDescription } from "../domain/read-description";
import { readAccess } from "../domain/read-access";
import { maximumToolsLimits } from "../domain/read-limits";
import { readJson } from "../domain/read-json";
const service=defineService<ToolsService>({name:"tools",methods:{
 list:{failure:readError,output(raw){const parsed=readJson(raw,{maxBytes:maximumToolsLimits.maxCatalogBytes,maxNodes:200000,maxDepth:64});if(!parsed.ok||!Array.isArray(parsed.value)||parsed.value.length>maximumToolsLimits.maxTools)return createFault("invalid-result");const output:ToolDescription[]=[];for(const item of parsed.value){const description=readDescription(item);if(!description.ok)return description;output.push(description.value);}return {ok:true,value:Object.freeze(output)};}},
 get:{failure:readError,output:raw=>raw===null?{ok:true,value:null}:readDescription(raw)},
 execute:{failure:readError,output(raw){const output=readOutput(raw,maximumToolsLimits.maxOutputBytes);return output.ok?output:createFault("invalid-result");}},
}});if(!service.ok)throw new Error("Invalid tools service definition");export const tools=service.value;
const guard=defineGuard<ToolAccess>({name:"tools/access",input:readAccess});if(!guard.ok)throw new Error("Invalid tool access definition");export const toolAccess=guard.value;
