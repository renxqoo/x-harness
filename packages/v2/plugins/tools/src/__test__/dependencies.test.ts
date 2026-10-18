import { expect,it } from "vitest";
import { definePlugin,defineService } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { createToolPlugin,toolAccess,tools } from "../index";
import { world,value,emptySchema,text,request } from "./helpers";
it("tool execution uses its own declared dependency and preserves the outer caller",async()=>{
 const clock=value(defineService<{read(input:void):Promise<Result<number>>}>({name:"clock",methods:{read:{}}}));let caller:unknown;
 const clockPlugin=definePlugin({name:"clock",provides:{clock},setup:ctx=>ctx.service({clock:{async read(){return {ok:true,value:42};}}})});
 const tool=value(createToolPlugin({name:"echo",requires:{clock},inputSchema:emptySchema,async execute(_input,call){const time=await call.deps.clock.read(undefined);if(!time.ok)return time;caller=call.caller;return text(String(time.value));}}));
 const {host,service}=await world([clockPlugin,tool]);try{expect(value(await service.execute(request())).content).toEqual([{type:"text",text:"42"}]);expect(caller).toMatchObject({scopeId:"root"});expect(caller).not.toHaveProperty("pluginName");}finally{value(await host.close());}
});
it("optional dependencies remain absent and cannot become an undeclared host escape",async()=>{
 const clock=value(defineService<{read(input:void):Promise<Result<number>>}>({name:"optional-clock",methods:{read:{}}}));
 const {host,service}=await world([value(createToolPlugin({name:"echo",optional:{clock},inputSchema:emptySchema,async execute(_input,call){return text(call.deps.clock?"present":"absent");}}))]);try{expect(value(await service.execute(request())).content).toEqual([{type:"text",text:"absent"}]);}finally{value(await host.close());}
});
it("deny wins over explicit allow and discovery does not expose denied tools",async()=>{
 let runs=0;const deny=definePlugin({name:"deny",requires:{toolAccess},setup:ctx=>ctx.guard("toolAccess",()=>({ok:true,value:{kind:"deny",reason:"policy"}}))});
 const {host,service}=await world([value(createToolPlugin({name:"echo",inputSchema:emptySchema,execute:async()=>{runs++;return text("no");}})),deny]);try{expect(value(await service.list({}))).toEqual([]);expect(value(await service.get({name:"echo"}))).toBeNull();expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"access-denied"}});expect(runs).toBe(0);}finally{value(await host.close());}
});
it("resources opened by a tool remain owned by the logical calling plugin",async()=>{
 let closed=0;const {host}=await world([value(createToolPlugin({name:"echo",inputSchema:emptySchema,async execute(_input,call){const opened=await call.resource({open:()=>({ok:true,value:"connection"}),close:()=>{closed++;return {ok:true,value:undefined};}});return opened.ok?text(opened.value):opened;}}))]);
 try{const installed=value(await host.install([definePlugin({name:"consumer",requires:{tools},async setup(ctx){return ctx.deps.tools.execute(request());}})]));expect(closed).toBe(0);value(await host.uninstall(installed.plugins[0]!));expect(closed).toBe(1);}finally{value(await host.close());}
});
