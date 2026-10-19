import type { AgentError } from "../contracts/types";
export function fail(code:AgentError["code"],details:Omit<AgentError,"source"|"code">={}):{readonly ok:false;readonly error:AgentError}{return {ok:false,error:Object.freeze({source:"agent-loop",code,...details})};}
