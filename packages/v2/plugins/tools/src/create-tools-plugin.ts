import { definePlugin } from "../../../core/src/index";
import type { Plugin,Invocation } from "../../../core/src/index";
import type { ToolsOptions,ToolsResult,ToolDescription } from "./contracts/types";
import { tools,toolAccess } from "./contracts";
import { toolCatalog,toolDispatch,makeTicket,closeTicket } from "./internal";
import { propagateCancellation } from "./execution/propagate-cancellation";
import { queryCatalog } from "./domain/query-catalog";
import { readLimits } from "./domain/read-limits";
import { readRequest } from "./domain/read-request";
import { readOutput } from "./domain/read-output";
import { data,keys,name } from "./domain/read-values";
import { fail } from "./domain/fail";
export function createToolsPlugin(raw:ToolsOptions={}):ToolsResult<Plugin>{
 const d=data(raw);if(!d||!keys(d,["access","limits"])||d.access!==undefined&&!["allow","required"].includes(d.access as string))return fail("invalid-input");const limits=readLimits(d.limits);if(!limits.ok)return limits;
 return {ok:true,value:definePlugin({name:"tools",provides:{tools,toolAccess,toolCatalog,toolDispatch},setup(ctx){let active=0;
  if(d.access==="allow"){const allow=ctx.guard("toolAccess",()=>({ok:true,value:{kind:"allow"}}));if(!allow.ok)return allow;}
  const catalog=ctx.handle("toolCatalog",()=>({ok:true,value:undefined}));if(!catalog.ok)return catalog;const terminal=ctx.handle("toolDispatch",()=>fail("not-found"));if(!terminal.ok)return terminal;
  const discover=async(call:Invocation)=>{const query=queryCatalog(limits.value);try{const result=await call.dispatch("toolCatalog",query.input);if(!result.ok)return result as ToolsResult<never>;return query.finish();}finally{query.close();}};
  const visible=async(raw:unknown,operation:"list"|"get",call:Invocation):Promise<ToolsResult<readonly ToolDescription[]>>=>{const d=data(raw);if(!d||!keys(d,operation==="list"?[]:["name"])||operation==="get"&&!name(d.name))return fail("invalid-input");const catalog=await discover(call);if(!catalog.ok)return catalog;const found:ToolDescription[]=[];
   for(const entry of catalog.value){if(operation==="get"&&entry.tool.name!==d.name)continue;const allowed=await call.dispatch("toolAccess",{operation,tool:entry.tool,origin:call.origin});if(!allowed.ok){if(allowed.error&&typeof allowed.error==="object"&&"code"in allowed.error&&allowed.error.code==="guard-unconfigured")continue;return allowed as ToolsResult<never>;}if((allowed.value as {kind:string}).kind==="allow")found.push(entry.tool);}return {ok:true,value:Object.freeze(found)};};
  return ctx.service({tools:{
   list:(input,call)=>visible(input,"list",call as Invocation),
   async get(input,call){const result=await visible(input,"get",call as Invocation);return result.ok?{ok:true,value:result.value[0]??null}:result;},
   async execute(raw,call){const input=readRequest(raw,limits.value.maxInputBytes);if(!input.ok)return input;if(active>=limits.value.maxActiveRequests)return fail("busy");active++;const cancel=(reason:"cancelled"|"timeout")=>{call.cancel(reason);};let ticket:ReturnType<typeof makeTicket>|undefined;
    const caller=call.origin;const task=call.spawn({label:"tools-request",signal:input.value.signal,timeoutMs:Math.min(input.value.timeoutMs??limits.value.timeoutMs,limits.value.timeoutMs),async run(child){const catalog=await discover(child as Invocation);if(!catalog.ok)return catalog;const entry=catalog.value.find(x=>x.tool.name===input.value.name);if(!entry)return fail("not-found");ticket=makeTicket({entry,request:input.value,caller,limits:limits.value,cancel});const output=await child.dispatch("toolDispatch",ticket);if(!output.ok)return propagateCancellation(output,cancel) as ToolsResult<never>;return readOutput(output.value,limits.value.maxOutputBytes);}});
    if(!task.ok){active--;return task;}try{return propagateCancellation(await call.wait(task.value),cancel);}finally{await task.value.finished;if(ticket)closeTicket(ticket);active--;}
   },
  }});
 }})};
}
