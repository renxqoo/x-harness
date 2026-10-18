import type { SchedulerError } from "../contracts/types";
export function fail(code:SchedulerError["code"]){return {ok:false as const,error:Object.freeze({source:"tool-scheduler" as const,code,message:code})};}
