import { expect,it } from "vitest";
import { definePlugin } from "../../../../core/src/index";
import type { Plugin } from "../../../../core/src/index";
import { createToolPlugin,toolAccess,toolExecutionAccess } from "../index";
import type { ToolAuthorization } from "../index";
import { deferred,emptySchema,request,text,value,world } from "./helpers";
const base=()=>definePlugin({name:"base-access",requires:{toolAccess},setup:ctx=>ctx.guard("toolAccess",()=>({ok:true,value:{kind:"allow"}}))});
const echo=()=>value(createToolPlugin({name:"echo",inputSchema:emptySchema,execute:async()=>text("done")}));
function policy(name="permission"):Plugin{return definePlugin({name,requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",authorization=>authorization.allow({signal:ctx.signal}))});}

it("ordinary guards grant permission and unloading the only grant provider denies new calls",async()=>{
 const {host,service}=await world([base(),policy(),echo()],{access:"required"});
 try{
  expect(await service.execute(request())).toEqual(text("done"));const prepared=value(await service.prepare(request()));
  const ref=host.inspect().plugins.find(p=>p.ref.name==="permission")!.ref;value(await host.uninstall(ref));
  expect(prepared.status()).toMatchObject({ok:false,error:{code:"access-denied"}});
  expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"access-denied"}});
 }finally{value(await host.close());}
});

it("an unconfigured execution guard or a bare allow cannot authorize a controlled request",async()=>{
 for(const plugins of [[],[definePlugin({name:"bare",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",()=>({ok:true,value:{kind:"allow"}}))})]]){
  const {host,service}=await world([base(),echo(),...plugins],{access:"required"});
  try{expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"access-denied"}});}finally{value(await host.close());}
 }
});

it("a saved grant callback is closed when checking ends and cannot append permissions later",async()=>{
 let allow:ToolAuthorization["allow"]|undefined;const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",authorization=>{allow=authorization.allow;return authorization.allow({signal:ctx.signal});})});
 const {host,service}=await world([base(),source,echo()],{access:"required"});
 try{const prepared=value(await service.prepare(request()));expect(allow!({signal:new AbortController().signal})).toMatchObject({ok:true,value:{kind:"deny"}});expect(await service.executePrepared({prepared})).toEqual(text("done"));}finally{value(await host.close());}
});

it.each(["revocation","predicate"])("ordinary grants enforce %s again at actual admission",async mode=>{
 const controller=new AbortController();let valid=true;const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",authorization=>authorization.allow({signal:ctx.signal,revocation:controller.signal,isValid:()=>valid}))});
 const {host,service}=await world([base(),source,echo()],{access:"required"});
 try{const prepared=value(await service.prepare(request()));if(mode==="revocation")controller.abort();else valid=false;expect(await service.executePrepared({prepared})).toMatchObject({ok:false,error:{code:"access-denied"}});}finally{value(await host.close());}
});

it("explicit allow cannot override a later denial or an ignored invalid grant",async()=>{
 for(const invalid of [false,true]){
  const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",authorization=>{
   if(invalid){authorization.allow({signal:{} as AbortSignal});return {ok:true,value:{kind:"allow"}};}
   return {ok:true,value:{kind:"deny",reason:"blocked"}};
  })});const {host,service}=await world([source,echo()]);
  try{expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"access-denied"}});}finally{value(await host.close());}
 }
});

it("approval waits without occupying execution capacity and revocation retains running capacity until exit",async()=>{
 const ask=deferred<boolean>(),entered=deferred(),finish=deferred(),revoke=new AbortController();let ready=false;
 const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",async authorization=>{
  if(!ready){const approved=await ask.promise;if(!approved)return {ok:true,value:{kind:"deny",reason:"rejected"}};}
  return authorization.allow({signal:ctx.signal,revocation:revoke.signal});
 })});
 const tool=value(createToolPlugin({name:"echo",inputSchema:emptySchema,execute:async()=>{entered.resolve();await finish.promise;return text("done");}}));const {host,service}=await world([base(),source,tool],{access:"required"});
 try{const preparing=service.prepare(request());ready=true;ask.resolve(true);const prepared=value(await preparing);const run=service.executePrepared({prepared});await entered.promise;revoke.abort();expect((await run).ok).toBe(false);expect(host.inspect().activeTasks).toBeGreaterThan(0);}finally{finish.resolve();value(await host.close());}
});

it.each([128,129])("ordinary grant registration enforces the shared bound at %i",async count=>{
 const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",authorization=>{
  for(let index=0;index<count;index++)authorization.allow({signal:ctx.signal});return {ok:true,value:{kind:"allow"}};
 })});const {host,service}=await world([base(),source,echo()],{access:"required"});
 try{expect((await service.execute(request())).ok).toBe(count===128);}finally{value(await host.close());}
});

it("revocation during a later approval cannot leave listeners on subsequent grants",async()=>{
 const first=new AbortController(),second=new AbortController(),entered=deferred(),finish=deferred();
 const source=definePlugin({name:"permission",requires:{toolExecutionAccess},setup:ctx=>ctx.guard("toolExecutionAccess",async authorization=>{
  authorization.allow({signal:ctx.signal,revocation:first.signal});authorization.allow({signal:ctx.signal,revocation:second.signal});entered.resolve();await finish.promise;return {ok:true,value:{kind:"allow"}};
 })});const {host,service}=await world([base(),source,echo()],{access:"required"});
 try{const pending=service.prepare(request());await entered.promise;first.abort();finish.resolve();expect(await pending).toMatchObject({ok:false,error:{code:"access-denied"}});expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"access-denied"}});}finally{finish.resolve();value(await host.close());}
});
