import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {createHost} from "../core/src/index";
import type {Result} from "../core/src/index";
import {createToolPlugin,createToolsPlugin,createToolPolicyPlugin} from "../plugins/tools/src/index";
import {createToolSchedulerPlugin,toolScheduler} from "../plugins/tool-scheduler/src/index";
import {execution} from "../plugins/execution/src/index";
import {createLocalExecutionPlugin} from "../plugins/execution-local/src/index";
import {createSandboxPlugin} from "../plugins/sandbox/src/index";
function value<T,E>(r:Result<T,E>){if(!r.ok)throw new Error(JSON.stringify(r.error));return r.value;}
const root=resolve(import.meta.dir,".."),hash=createHash("sha256"),files:string[]=[];
for(const pattern of ["core/src/**/*.ts",...(["execution","execution-process","execution-local","sandbox","tools","tool-scheduler"].map(name=>`plugins/${name}/src/**/*.ts`))])for await(const path of new Bun.Glob(pattern).scan({cwd:root}))if(!path.includes("/__test__/"))files.push(path);
for(const path of files.sort())hash.update(path).update(await readFile(resolve(root,path)));hash.update(await readFile(import.meta.path));
const samples:{kind:string;run:number;calls:number;milliseconds:number;peak:number;permissionPeak?:number}[]=[];
for(const kind of ["read","write","permission"] as const)for(let run=0;run<4;run++){
 const host=value(createHost({limits:{callTimeoutMs:30000,maxCallDepth:256}}));let active=0,peak=0,permissionActive=0,permissionPeak=0;
 try{
  const policy=value(createToolPolicyPlugin({name:"benchmark",async authorize(){permissionActive++;permissionPeak=Math.max(permissionPeak,permissionActive);if(kind==="permission")await Bun.sleep(5);permissionActive--;return {ok:true,value:{kind:"allow"}};}}));
  const tool=value(createToolPlugin({name:"operation",concurrency:8,inputSchema:{type:"object"},prepare:async()=>({ok:true,value:{resources:kind==="permission"?[]:[{domain:"benchmark",path:["row"],mode:kind,scope:"exact"}]}}),async execute(){active++;peak=Math.max(peak,active);await Bun.sleep(1);active--;return {ok:true,value:{content:[]}};}}));
  value(await host.install([value(createToolsPlugin({access:"allow"})),value(createToolSchedulerPlugin({access:"allow",limits:{concurrency:kind==="permission"?2:8}})),policy,tool]));
  const service=value(host.use(toolScheduler)),start=performance.now();const report=value(await service.batch({calls:Array.from({length:32},(_,index)=>({name:"operation",callId:String(index),input:{}}))}));const milliseconds=performance.now()-start;
  if(report.results.some(x=>!x.result.ok)||kind==="read"&&peak<2||kind==="write"&&peak!==1||kind==="permission"&&(peak>2||permissionPeak<=2))throw new Error("Concurrency observation failed");
  if(host.inspect().activeTasks||host.inspect().activeCalls)throw new Error("Owned work not drained");if(run)samples.push({kind,run,calls:32,milliseconds,peak,permissionPeak});
 }finally{value(await host.close());}
}
const directory=await mkdtemp(join(tmpdir(),"xh-execution-benchmark-"));try{for(const kind of ["local","sandbox"] as const){if(kind==="sandbox"&&process.platform!=="darwin")continue;const host=value(createHost({limits:{callTimeoutMs:15000,maxCallDepth:256}}));try{const factory=kind==="local"?createLocalExecutionPlugin:createSandboxPlugin;value(await host.install([value(factory({profiles:{workspace:{cwd:directory}}}))]));const service=value(host.use(execution));for(let run=0;run<4;run++){const start=performance.now(),target=value(await service.prepare({profile:"workspace",argv:["/usr/bin/true"]}));const result=value(await service.run({target})),milliseconds=performance.now()-start;if(result.exitCode!==0||host.inspect().activeTasks)throw new Error("Command did not complete");if(run)samples.push({kind,run,calls:1,milliseconds,peak:1});}}finally{value(await host.close());}}}finally{await rm(directory,{recursive:true,force:true});}
await mkdir(resolve(root,"reviews/tool-execution"),{recursive:true});await writeFile(resolve(root,"reviews/tool-execution/benchmark.json"),JSON.stringify({command:"bun run benchmark:execution",timestamp:new Date().toISOString(),runtime:Bun.version,platform:process.platform,arch:process.arch,sourceSha256:hash.digest("hex"),hashedProductionFiles:files.length,warmupRuns:1,samples,interpretation:"Local end-to-end observations with 1ms simulated tool work and 5ms policy waiting, plus real process startup and drain. Read concurrency and serial conflicting writes are asserted. Sandbox includes per-command SRT worker startup; no comparison with other frameworks, distributed availability or peak-heap claim."},null,2)+"\n");process.stdout.write(`${samples.length} coordinated batch and process samples completed\n`);
