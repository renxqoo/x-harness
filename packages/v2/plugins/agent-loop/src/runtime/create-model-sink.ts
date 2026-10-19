import type { LlmEvent } from "../../../llm/src/index";
import type { AgentEmitter } from "./create-emitter";
export function createModelSink(emitter:AgentEmitter,step:number){let current:AgentEmitter|undefined=emitter;const controller=new AbortController();return {signal:controller.signal,onEvent:async(event:LlmEvent)=>{const result=await current?.send({type:"model-event",step,event});if(result&&!result.ok){controller.abort();emitter.cancel();}},close(){current=undefined;controller.abort();}};}
