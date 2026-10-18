import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {Dir} from "node:fs";
import {readWorkerInput} from "../read-worker-input";
import {readWorkerMessage} from "../read-worker-message";
import {checkFilesystemRoots} from "../check-filesystem-roots";
const input=()=>({target:{cwd:"/tmp",argv:["/bin/echo"],env:{}},profile:{readRoots:["/tmp"],writeRoots:[],allowedDomains:[]},work:"/tmp/work",jobRoot:"/tmp/job",protectedPaths:["/usr"]});
it.each([null,{}, {...input(),extra:true},{...input(),target:null},{...input(),profile:[]},{...input(),work:"relative"},{...input(),jobRoot:2},{...input(),protectedPaths:["relative"]},{...input(),target:{cwd:"/",argv:[],env:{}}},{...input(),target:{cwd:"/",argv:["/bin/echo"],env:{A:3}}},{...input(),profile:{readRoots:[],writeRoots:[],allowedDomains:null}}] as unknown[])("malformed worker control inputs fail closed %#",raw=>{expect(readWorkerInput(raw)).toBeUndefined();});
it("valid worker fields are parsed independently within their complete control budget",()=>{const raw=input();raw.target.env={A:"x".repeat(35000)};expect(readWorkerInput(raw)?.target.env.A).toHaveLength(35000);});
it.each([null,{}, {kind:"done",exitCode:1.5},{kind:"done",exitCode:0,extra:true},{kind:"failed",code:"secret"}] as unknown[])("worker replies have closed neutral shapes %#",raw=>{expect(readWorkerMessage(raw)).toBeUndefined();});
it("worker reply vocabulary preserves a command exit and a neutral unavailable failure",()=>{expect(readWorkerMessage({kind:"done",exitCode:7})).toEqual({kind:"done",exitCode:7});expect(readWorkerMessage({kind:"failed",code:"backend-unavailable"})).toEqual({kind:"failed",code:"backend-unavailable"});});
it("filesystem scanning stops on cancellation missing paths and an exhausted budget",async()=>{const abort=new AbortController();abort.abort();expect(await checkFilesystemRoots({roots:["/"],signal:abort.signal,maxEntries:1})).toMatchObject({ok:false,error:{code:"cancelled"}});expect(await checkFilesystemRoots({roots:["/xh-nonexistent"],signal:new AbortController().signal,maxEntries:1})).toMatchObject({ok:false,error:{code:"access-denied"}});expect(await checkFilesystemRoots({roots:["/"],signal:new AbortController().signal,maxEntries:1})).toMatchObject({ok:false,error:{code:"access-denied"}});});

it("wide directory scans fail at their bound and close each directory before retrying",async()=>{const root=await mkdtemp(join(tmpdir(),"xh-scan-bound-"));const closed=vi.spyOn(Dir.prototype,"close");try{await Promise.all(Array.from({length:64},(_,i)=>writeFile(join(root,String(i)),"x")));for(let i=0;i<8;i++)expect(await checkFilesystemRoots({roots:[root],signal:new AbortController().signal,maxEntries:8})).toMatchObject({ok:false,error:{code:"access-denied"}});expect(await checkFilesystemRoots({roots:[root],signal:new AbortController().signal,maxEntries:65})).toEqual({ok:true,value:undefined});expect(closed).toHaveBeenCalledTimes(9);}finally{closed.mockRestore();await rm(root,{recursive:true,force:true});}});
