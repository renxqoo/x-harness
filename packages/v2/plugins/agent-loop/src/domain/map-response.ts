import type {LlmResponse,LlmMessage,AssistantContent,LlmToolCall} from "../../../llm/src/index";
import type {AgentResult} from "../contracts/types";
import {fail} from "./fail";
export function mapResponse(response:LlmResponse):AgentResult<{message?:LlmMessage;calls:readonly LlmToolCall[]}>{
 const executable=response.reason.kind==="tool-calls";const content:AssistantContent[]=[],calls:LlmToolCall[]=[];let replayable=true;
 for(const entry of response.content){if(entry.status!=="complete"){if(executable)return fail("invalid-model-output");replayable=false;}
  if(entry.block.kind==="text"||entry.block.kind==="refusal")content.push({type:entry.block.kind,text:entry.text??""});
  else if(entry.block.kind==="reasoning"){if(entry.signature&&!entry.continuation)replayable=false;if(entry.text!==undefined||entry.continuation)content.push({type:"reasoning",...(entry.text!==undefined?{text:entry.text}:{}),...(entry.continuation?{continuation:entry.continuation}:{})});}
  else if(entry.block.kind==="provider"){if(entry.continuation)content.push({type:"provider",continuation:entry.continuation});else replayable=false;}
  else if(entry.block.kind==="tool-call"){replayable=false;if(executable){if(!entry.call?.input.ok)return fail("invalid-model-output");calls.push(entry.call);content.push({type:"tool-call",callId:entry.call.callId,name:entry.call.name,input:entry.call.input.value});}}
 }
 if(executable){if(!calls.length||response.content.some(entry=>entry.block.kind==="provider"&&!entry.continuation||entry.signature&&!entry.continuation))return fail("invalid-model-output");replayable=true;}
 if(!content.length)content.push({type:"text",text:""});return {ok:true,value:{...(replayable?{message:Object.freeze({role:"assistant",content:Object.freeze(content)}) as LlmMessage}:{}),calls:Object.freeze(calls)}};
}
