import { expect,it } from "vitest";
import { definePlugin,defineService } from "../../../../core/src/index";
import type { Plugin,Result } from "../../../../core/src/index";
import { toolCatalog,toolPreparation,toolDispatch,toolExecutionAccess } from "../index";
import type { ToolDescription,ToolDispatchRequest,ToolOutput,ToolExecutionLimits,ToolEffects } from "../index";
import { deferred,emptySchema,flush,request,text,value,world } from "./helpers";

function ordinary(options:{name?:string;tool?:ToolDescription;limits?:Partial<ToolExecutionLimits>;prepare?:()=>ToolEffects;run:(request:ToolDispatchRequest)=>Promise<Result<ToolOutput>>}):Plugin{
 const name=options.name??"echo";
 return definePlugin({name:`ordinary-${name}`,requires:{toolCatalog,toolPreparation,toolDispatch},setup(ctx){
  const entry=Object.freeze({signal:ctx.signal,tool:options.tool??{name,concurrency:1,inputSchema:emptySchema},...(options.limits?{limits:options.limits}:{})});
  const catalog=ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit(entry);return sent.ok?next(query):sent;});if(!catalog.ok)return catalog;
  const preparation=ctx.middleware("toolPreparation",(input,next)=>input.ownerSignal===ctx.signal&&input.name===name?{ok:true,value:options.prepare?.()??{}}:next(input));if(!preparation.ok)return preparation;
  return ctx.middleware("toolDispatch",(input,next)=>input.ownerSignal===ctx.signal&&input.name===name?options.run(input):next(input));
 }});
}

it("an ordinary plugin contributes a tool through public contracts without a factory",async()=>{
 let prepared=0;const progress:string[]=[];const {host,service}=await world([ordinary({prepare(){prepared++;return {actions:{echo:true}};},async run(input){expect(Object.isFrozen(input)).toBe(true);expect(Object.isFrozen(input.input)).toBe(true);expect(input.plan.actions).toEqual({echo:true});value(await input.progress("working"));return text("done");}})]);
 try{expect(value(await service.list({}))).toHaveLength(1);expect(await service.execute({...request(),onProgress:delta=>{progress.push(delta);}})).toEqual(text("done"));expect(prepared).toBe(1);expect(progress).toEqual(["working"]);}finally{value(await host.close());}
});

it("ordinary handlers receive their declared dependencies and the actual plugin executor",async()=>{
 const token=value(defineService<{read(input:void):Promise<Result<string>>}>({name:"clock",methods:{read:{}}}));
 const provider=definePlugin({name:"clock",provides:{token},setup:ctx=>ctx.service({token:{async read(){return {ok:true,value:"clock"};}}})});
 const author=definePlugin({name:"ordinary",requires:{token,toolCatalog,toolPreparation,toolDispatch},setup(ctx){
  const entry={signal:ctx.signal,tool:{name:"echo",concurrency:1,inputSchema:emptySchema}};
  const catalog=ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit(entry);return sent.ok?next(query):sent;});if(!catalog.ok)return catalog;
  const preparation=ctx.middleware("toolPreparation",(input,next)=>input.ownerSignal===ctx.signal?{ok:true,value:{}}:next(input));if(!preparation.ok)return preparation;
  return ctx.middleware("toolDispatch",async(input,next,call)=>{if(input.ownerSignal!==ctx.signal)return next(input);expect(call.executor.pluginName).toBe("ordinary");const read=await call.deps.token.read();return read.ok?text(read.value):read;});
 }});
 const {host,service}=await world([provider,author]);try{expect(await service.execute(request())).toEqual(text("clock"));}finally{value(await host.close());}
});

it("ordinary tools cannot bypass input schemas by omitting factory validation",async()=>{
 let prepares=0,runs=0;const {host,service}=await world([ordinary({tool:{name:"echo",concurrency:1,inputSchema:{type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:false}},prepare(){prepares++;return {};},async run(){runs++;return text("done");}})]);
 try{expect(await service.execute(request("echo",{count:"bad"}))).toMatchObject({ok:false,error:{code:"invalid-input"}});expect(prepares).toBe(0);expect(runs).toBe(0);}finally{value(await host.close());}
});

it.each(["shape","schema","bytes"])("ordinary tools enforce %s output validation at the runtime boundary",async mode=>{
 const {host,service}=await world([ordinary({tool:{name:"echo",concurrency:1,inputSchema:emptySchema,...(mode==="schema"?{outputSchema:{type:"object" as const,required:["answer"],properties:{answer:{type:"integer"}}}}:{})},limits:mode==="bytes"?{maxOutputBytes:10}:undefined,async run(){return mode==="shape"?{ok:true,value:{content:[{type:"text",text:1}]}} as never:text("done");}})]);
 try{expect(await service.execute(request())).toMatchObject({ok:false,error:{code:mode==="bytes"?"capacity-exceeded":"invalid-output"}});}finally{value(await host.close());}
});

it("ordinary tools cannot ignore progress failures and return success",async()=>{
 const {host,service}=await world([ordinary({limits:{maxProgressBytes:1},async run(input){await input.progress("too long");return text("done");}})]);
 try{expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"capacity-exceeded"}});}finally{value(await host.close());}
});

it("ordinary tools retain their concurrency slot after cancellation until the actual handler exits",async()=>{
 const entered=deferred(),finish=deferred(),controller=new AbortController();let runs=0;const {host,service}=await world([ordinary({async run(){runs++;entered.resolve();if(runs===1)await finish.promise;return text("done");}})]);
 try{const first=service.execute({...request(),signal:controller.signal});await entered.promise;controller.abort();expect((await first).ok).toBe(false);expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"busy"}});expect(runs).toBe(1);finish.resolve();for(let i=0;i<100&&host.inspect().activeTasks;i++)await new Promise(resolve=>setTimeout(resolve,1));expect((await service.execute(request())).ok).toBe(true);}finally{finish.resolve();value(await host.close());}
});

it("reinstalling the same ordinary plugin cannot redirect an old dispatch to its new handler",async()=>{
 const entered=deferred(),finish=deferred();let runs=0,holding=true;
 const hold=definePlugin({name:"hold",requires:{toolDispatch},setup:ctx=>ctx.middleware("toolDispatch",async(input,next)=>{if(holding){holding=false;entered.resolve();await finish.promise;}return next(input);})});
 const plugin=ordinary({async run(){runs++;return text("done");}});const {host,service}=await world([hold]);
 try{const old=value(await host.install([plugin]));const pending=service.execute(request());await entered.promise;value(await host.uninstall(old.plugins[0]!));value(await host.install([plugin]));finish.resolve();expect((await pending).ok).toBe(false);expect(runs).toBe(0);expect(await service.execute(request())).toEqual(text("done"));expect(runs).toBe(1);}finally{finish.resolve();value(await host.close());}
});

it("admitted ordinary requests keep their owner when a same-name contribution arrives",async()=>{
 const entered=deferred(),finish=deferred();let oldRuns=0,newRuns=0,holding=true;
 const hold=definePlugin({name:"hold",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",async authorization=>{if(holding){holding=false;entered.resolve();await finish.promise;}return authorization.allow({signal:ctx.signal});})});
 const first=ordinary({async run(){oldRuns++;return text("old");}}),second={...ordinary({async run(){newRuns++;return text("new");}}),name:"second"};const {host,service}=await world([hold,first]);
 try{const pending=service.execute(request());await entered.promise;value(await host.install([second]));finish.resolve();expect(await pending).toEqual(text("old"));expect(oldRuns).toBe(1);expect(newRuns).toBe(0);expect(await service.list({})).toMatchObject({ok:false,error:{code:"name-conflict"}});}finally{finish.resolve();value(await host.close());}
});

it("catalog snapshots ignore later author mutations and reject untrusted byte counters",async()=>{
 const schema={type:"object" as const,additionalProperties:false};const description={name:"echo",concurrency:1,inputSchema:schema};let contribution:unknown;
 const plugin=definePlugin({name:"ordinary",requires:{toolCatalog},setup:ctx=>{contribution={signal:ctx.signal,tool:description};return ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit(contribution as never);return sent.ok?next(query):sent;});}});const {host,service}=await world([plugin]);
 try{expect(value(await service.list({}))[0]!.name).toBe("echo");description.name="changed";schema.additionalProperties=true;expect(value(await service.list({}))[0]!.name).toBe("echo");const extra=definePlugin({name:"bad",requires:{toolCatalog},setup:ctx=>ctx.middleware("toolCatalog",(query,next)=>{query.visit({signal:ctx.signal,tool:{name:"bad",concurrency:1,inputSchema:emptySchema},bytes:0} as never);return next(query);})});value(await host.install([extra]));expect(await service.list({})).toMatchObject({ok:false,error:{code:"invalid-output"}});}finally{value(await host.close());}
});

it("a copied preparation request cannot replace the sealed input",async()=>{
 let runs=0;const tamper=definePlugin({name:"tamper",requires:{toolPreparation},setup:ctx=>ctx.middleware("toolPreparation",(input,next)=>next({...input}))});const {host,service}=await world([tamper,ordinary({async run(){runs++;return text("done");}})]);
 try{expect((await service.execute(request())).ok).toBe(false);expect(runs).toBe(0);await flush();}finally{value(await host.close());}
});
it("fresh catalog objects keep one installation identity and cannot bypass concurrency",async()=>{
 const entered=deferred(),finish=deferred();let runs=0;
 const author=definePlugin({name:"ordinary-fresh",requires:{toolCatalog,toolPreparation,toolDispatch},setup(ctx){
  const catalog=ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit({signal:ctx.signal,tool:{name:"echo",concurrency:1,inputSchema:emptySchema}});return sent.ok?next(query):sent;});if(!catalog.ok)return catalog;
  const prepare=ctx.middleware("toolPreparation",(input,next)=>input.ownerSignal===ctx.signal?{ok:true,value:{}}:next(input));if(!prepare.ok)return prepare;
  return ctx.middleware("toolDispatch",async(input,next)=>{if(input.ownerSignal!==ctx.signal)return next(input);runs++;entered.resolve();if(runs===1)await finish.promise;return text("done");});
 }});const {host,service}=await world([author]);
 try{const a=value(await service.prepare(request())),b=value(await service.prepare(request()));expect(a.plan.installation).toBe(b.plan.installation);value(await service.discard({prepared:a}));value(await service.discard({prepared:b}));const first=service.execute(request());await entered.promise;expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"busy"}});expect(runs).toBe(1);finish.resolve();expect(await first).toEqual(text("done"));}finally{finish.resolve();value(await host.close());}
});

it("conflicting fresh descriptions cannot change a tool inside the same owner lifetime",async()=>{
 let concurrency=1;const author=definePlugin({name:"ordinary",requires:{toolCatalog},setup:ctx=>ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit({signal:ctx.signal,tool:{name:"echo",concurrency,inputSchema:emptySchema}});return sent.ok?next(query):sent;})});const {host,service}=await world([author]);
 try{expect(value(await service.list({}))).toHaveLength(1);concurrency=2;expect(await service.list({})).toMatchObject({ok:false,error:{code:"name-conflict"}});}finally{value(await host.close());}
});

it("owner identity indexes bound rotating catalog names and reset after reinstall",async()=>{
 let name="tool0";const author=definePlugin({name:"ordinary",requires:{toolCatalog},setup:ctx=>ctx.middleware("toolCatalog",(query,next)=>{const sent=query.visit({signal:ctx.signal,tool:{name,concurrency:1,inputSchema:emptySchema}});return sent.ok?next(query):sent;})});const {host,service}=await world();
 try{const installed=value(await host.install([author]));for(let i=0;i<128;i++){name=`tool${i}`;expect(value(await service.list({}))[0]!.name).toBe(name);}name="overflow";expect(await service.list({})).toMatchObject({ok:false,error:{code:"capacity-exceeded"}});value(await host.uninstall(installed.plugins[0]!));value(await host.install([author]));expect(value(await service.list({}))[0]!.name).toBe("overflow");}finally{value(await host.close());}
});

it("equivalent Unicode schema keys in a different order keep one contribution identity",async()=>{
 let reverse=false;const author=definePlugin({name:"unicode",requires:{toolCatalog},setup:ctx=>ctx.middleware("toolCatalog",(query,next)=>{const pairs:[[string,{type:"string"}],[string,{type:"string"}]]=[["é",{type:"string"}],["e\u0301",{type:"string"}]];if(reverse)pairs.reverse();const sent=query.visit({signal:ctx.signal,tool:{name:"echo",concurrency:1,inputSchema:{type:"object",properties:Object.fromEntries(pairs)}}});return sent.ok?next(query):sent;})});const {host,service}=await world([author]);
 try{expect(await service.list({})).toMatchObject({ok:true,value:[expect.objectContaining({name:"echo"})]});reverse=true;expect(await service.list({})).toMatchObject({ok:true,value:[expect.objectContaining({name:"echo"})]});}finally{value(await host.close());}
});
