import { createFault } from "../../../../core/src/validation";
import { toolsErrorCodes } from "../contracts/types";
import type { ToolsError } from "../contracts/types";
import { data,keys } from "./read-values";
export function readError(raw:unknown){const read=data(raw);if(!read||!keys(read,["source","code","message"])||read.source!=="tools"||!toolsErrorCodes.includes(read.code as ToolsError["code"])||read.message!==read.code)return createFault("invalid-result");return {ok:true as const,value:Object.freeze(read) as unknown as ToolsError};}
