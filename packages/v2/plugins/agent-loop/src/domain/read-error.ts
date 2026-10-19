import type { AgentError } from "../contracts/types";
import { agentErrorCodes } from "../contracts/types";
import { readJson } from "./read-json";
import { data,keys,text,count } from "./read-values";
import { fail } from "./fail";
export function readError(raw:unknown){const read=readJson(raw,4096);const d=read.ok?data(read.value):undefined;if(!d||!keys(d,["source","code","runId","step","toolsMayHaveRun"])||d.source!=="agent-loop"||!(agentErrorCodes as readonly unknown[]).includes(d.code)||d.runId!==undefined&&!text(d.runId)||d.step!==undefined&&!count(d.step)||d.toolsMayHaveRun!==undefined&&typeof d.toolsMayHaveRun!=="boolean")return fail("invalid-output");return {ok:true as const,value:read.ok?read.value as unknown as AgentError:undefined as never};}
