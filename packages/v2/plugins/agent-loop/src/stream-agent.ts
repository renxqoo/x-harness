import type {AgentLoopService,AgentRunInput} from "./contracts";
import {createStream} from "./stream/create-stream";
export function streamAgent(service:AgentLoopService,input:Omit<AgentRunInput,"onEvent">){return createStream({service,input});}
