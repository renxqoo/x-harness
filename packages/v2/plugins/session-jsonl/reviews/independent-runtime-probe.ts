import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJsonlStore } from '../src/open-store.ts';
import { createJsonlStorage } from '../src/create-storage-service.ts';
import { createFileIO } from '../src/create-file-io.ts';
import { defaultJsonlLimits } from '../src/read-options.ts';
import { defaultSessionLimits, storagePolicyKeys } from '../../session/src/storage.ts';
const root=await realpath(await mkdtemp(join(tmpdir(),'jsonl-review-'))); const file=join(root,'namespaces/n/sessions/s.jsonl');
const policy=Object.fromEntries(storagePolicyKeys.map(k=>[k,defaultSessionLimits[k]]));const hash='a'.repeat(64);const key={namespace:'n',id:'s'};const ctx={signal:new AbortController().signal};
const io=createFileIO();const originalOpen=io.open;let armed=false;let footerWritten=false;let failures=0;
io.open=async(...args:any[])=>{const handle=await originalOpen(...args);if(String(args[0])!==file)return handle;return new Proxy(handle,{get(target,k){if(k==='write')return async(...p:any[])=>{const result=await target.write(...p);if(armed&&p[0].toString().includes('"kind":"commit"'))footerWritten=true;return result;};if(k==='sync')return async()=>{if(armed&&footerWritten){armed=false;failures++;throw Error('sync outcome unknown');}await target.sync();};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});};
const a=await openJsonlStore(root,defaultJsonlLimits,io);const b=await openJsonlStore(root,defaultJsonlLimits);const sa=createJsonlStorage(a);const sb=createJsonlStorage(b);const call=(s:any,m:string,v:any)=>s[m](v,ctx);const get=(r:any)=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value;};let checked=0;const check=(v:boolean,label:string)=>{if(!v)throw Error(label);checked++;};
try{
 get(await call(sa,'initialize',{namespace:'n',policy}));get(await call(sa,'create',{...key,origin:hash,metadata:'null'}));
 const first={...key,expectedRevision:0,commitId:'unknown',fingerprint:hash,records:[{seq:1,time:0,json:'x',bytes:1}],nodes:[{position:1,seq:1}]};armed=true;const failed=await call(sa,'commit',first);check(!failed.ok&&failures===1,'must observe sync failure');check(get(await call(sb,'getCommit',{...key,commitId:'unknown'})).receipt.revision===1,'other instance confirms complete footer');check(get(await call(sa,'commit',first)).revision===1,'retry is same receipt');
 const nodes=Array.from({length:4096},(_,i)=>({position:i+1,seq:i+1}));let revision=1;const receipts=['unknown'];
 for(let batch=0;batch<8;batch++){const count=batch===7?511:512;const records=Array.from({length:count},(_,i)=>({seq:revision+i+1,time:i,json:'x',bytes:1}));const commitId=`seed${batch}`;get(await call(sa,'commit',{...key,expectedRevision:revision,commitId,fingerprint:hash,records,nodes:nodes.slice(0,revision+count)}));revision+=count;receipts.push(commitId);}
 for(let turn=0;turn<40;turn++){const commitId=`turn${turn}`;get(await call(sa,'commit',{...key,expectedRevision:revision,commitId,fingerprint:hash,records:[{seq:++revision,time:0,json:'x',bytes:1}],nodes:turn%2?nodes:[]}));receipts.push(commitId);}
 const raw=await readFile(file,'utf8');check(JSON.parse(raw.split('\n')[0]).payload.mode==='snapshot','churn triggers snapshot');
 for(const s of [sa,sb]){for(const commitId of receipts)check(get(await call(s,'getCommit',{...key,commitId})).receipt.commitId===commitId,'receipt survives snapshot');const page=get(await call(s,'history',{...key,after:0,limit:4000,maxPageBytes:16777216}));check(page.records.length===4000&&page.records[3999].seq===4000,'history uses replacement offsets');const end=get(await call(s,'history',{...key,after:4000,limit:4000,maxPageBytes:16777216}));check(end.records.at(-1).seq===revision,'history end survives replacement');}
 console.log(JSON.stringify({checked,unknownSyncFailures:failures,revision,receipts:receipts.length,bytes:Buffer.byteLength(raw)}));
}finally{await a.close();await b.close();await rm(root,{recursive:true,force:true});}
