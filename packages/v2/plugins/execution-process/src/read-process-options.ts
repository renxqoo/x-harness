import {readData,readJsonValue,signalAborted} from "../../../core/src/validation";
import type {ExecutionResult} from "../../execution/src/index";
import {fail} from "./fail";
export interface ProcessOptions {
 readonly argv:readonly string[];
 readonly cwd:string;
 readonly env:Readonly<Record<string,string>>;
 readonly signal:AbortSignal;
 readonly maxOutputBytes:number;
 readonly stdin?:string;
 readonly onMessage?:(message:unknown)=>void;
}
export function readProcessOptions(raw:unknown):ExecutionResult<ProcessOptions>{
 const data=readData(raw);if(!data.ok)return fail("invalid-input");const d=data.value;
 if(Object.keys(d).some(k=>!["argv","cwd","env","signal","maxOutputBytes","stdin","onMessage"].includes(k)))return fail("invalid-input");
 const argv=readJsonValue(d.argv),env=readJsonValue(d.env);
 if(!argv.ok||!Array.isArray(argv.value)||!argv.value.length||argv.value.length>256||argv.value.some(x=>typeof x!=="string"||x.includes("\0"))||!(argv.value[0] as string).startsWith("/")||!env.ok||!readData(env.value).ok||typeof d.cwd!=="string"||!d.cwd.startsWith("/")||d.cwd.includes("\0")||!Number.isSafeInteger(d.maxOutputBytes)||(d.maxOutputBytes as number)<1||(d.maxOutputBytes as number)>16777216||d.stdin!==undefined&&(typeof d.stdin!=="string"||new TextEncoder().encode(d.stdin).length>262144)||d.onMessage!==undefined&&typeof d.onMessage!=="function")return fail("invalid-input");
 const environment=env.value as Record<string,unknown>;
 if(Object.entries(environment).some(([key,value])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)||typeof value!=="string"||value.includes("\0")))return fail("invalid-input");
 try{signalAborted(d.signal as AbortSignal);}catch{return fail("invalid-input");}
 return {ok:true,value:{argv:argv.value as string[],env:environment as Record<string,string>,cwd:d.cwd,signal:d.signal as AbortSignal,maxOutputBytes:d.maxOutputBytes as number,...(d.stdin!==undefined?{stdin:d.stdin as string}:{}),...(d.onMessage!==undefined?{onMessage:d.onMessage as (message:unknown)=>void}:{})}};
}
