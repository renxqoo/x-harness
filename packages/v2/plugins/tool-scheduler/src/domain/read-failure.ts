import { createFault } from "../../../../core/src/validation";
import { readToolError } from "../../../tools/src/validation";
import { schedulerErrorCodes } from "../contracts/types";
import type { SchedulerError } from "../contracts/types";
import { data,keys } from "./read-values";
export function readFailure(raw:unknown){const d=data(raw);if(d?.source==="tools")return readToolError(raw);if(!d||!keys(d,["source","code","message"])||d.source!=="tool-scheduler"||!schedulerErrorCodes.includes(d.code as SchedulerError["code"])||d.message!==d.code)return createFault("invalid-result");return {ok:true as const,value:Object.freeze(d) as unknown as SchedulerError};}
