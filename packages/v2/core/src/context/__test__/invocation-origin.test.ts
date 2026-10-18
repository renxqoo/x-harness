import {expect,it} from "vitest";
import {defineService,definePlugin} from "../../index";
import type {Invocation,Result} from "../../index";
import {root,value,clock} from "../../__test__/helpers";
it("delegated metadata preserves the initiating owner and an installation lifetime independent of a completed call",async()=>{
 const inner=value(defineService<{read(input:void):Promise<Result<void>>}>({name:"origin-inner",methods:{read:{}}}));
 const outer=value(defineService<{read(input:void):Promise<Result<void>>}>({name:"origin-outer",methods:{read:{}}}));
 let saved:Invocation|undefined;
 const provider=definePlugin({name:"origin-provider",provides:{inner},setup:ctx=>ctx.service({inner:{async read(_input,call){saved=call;return {ok:true,value:undefined};}}})});
 const relay=()=>definePlugin({name:"origin-relay",requires:{inner},provides:{outer},setup:ctx=>ctx.service({outer:{read:(_input,call)=>call.deps.inner.read()}})});
 const host=root();try{const installed=value(await host.install([provider,relay()]));value(await value(host.use(outer)).read());const first=saved!;
  expect(first.origin.pluginName).toBe("origin-relay");expect(first.initiator).toEqual({id:"host",kind:"host",scopeId:"root"});expect(Object.isFrozen(first.initiator)).toBe(true);expect(first.remainingMs).toBe(0);expect(first.originSignal.aborted).toBe(false);
  value(await host.uninstall(installed.plugins[1]!));expect(first.originSignal.aborted).toBe(true);
  value(await host.install([relay()]));value(await value(host.use(outer)).read());expect(saved!.originId).not.toBe(first.originId);expect(saved!.originSignal.aborted).toBe(false);
 }finally{value(await host.close());}
});
it("remaining budget uses the injected scheduler and closes with its invocation",async()=>{
 const time=clock(),host=root({scheduler:time.scheduler});let saved:Invocation|undefined;
 try{const task=value(host.startTask({label:"budget",timeoutMs:100,run(call){saved=call;expect(call.remainingMs).toBe(100);time.jump(37);expect(call.remainingMs).toBe(63);time.jump(100);expect(call.remainingMs).toBe(0);return {ok:true,value:undefined};}}));expect((await host.wait(task)).ok).toBe(false);expect(saved!.remainingMs).toBe(0);}finally{value(await host.close());}
});
it.each(["throw","nan"])("remaining budget fails closed for an invalid scheduler reading %s",async mode=>{
 const time=clock();let bad=false;const host=root({scheduler:{...time.scheduler,now(){if(bad){if(mode==="throw")throw new Error("clock");return NaN;}return time.scheduler.now();}}});
 try{const task=value(host.startTask({label:"clock",run(call){bad=true;expect(call.remainingMs).toBe(0);bad=false;return {ok:true,value:undefined};}}));value(await host.wait(task));}finally{bad=false;value(await host.close());}
});
