import {readData,readJsonValue} from "../../../core/src/validation";
import type {ExecutionTarget} from "../../execution/src/index";
import type {CanonicalProfile} from "../../execution-process/src/index";
export function readWorkerInput(raw:unknown){
 const data=readData(raw);if(!data.ok)return;const d=data.value;
 if(Object.keys(d).some(k=>!["target","profile","work","jobRoot","protectedPaths"].includes(k)))return;
 const target=readJsonValue(d.target),profile=readJsonValue(d.profile),paths=readJsonValue(d.protectedPaths);
 if(!target.ok||!profile.ok||!paths.ok||typeof d.work!=="string"||!d.work.startsWith("/")||typeof d.jobRoot!=="string"||!d.jobRoot.startsWith("/")||!Array.isArray(paths.value)||paths.value.some(p=>typeof p!=="string"||!p.startsWith("/")))return;
 const t=readData(target.value),p=readData(profile.value);if(!t.ok||!p.ok)return;
 if(typeof t.value.cwd!=="string"||!t.value.cwd.startsWith("/")||!Array.isArray(t.value.argv)||!t.value.argv.length||t.value.argv.some(v=>typeof v!=="string"||v.includes("\0"))||!readData(t.value.env).ok||Object.values(t.value.env as object).some(v=>typeof v!=="string"))return;
 for(const key of ["readRoots","writeRoots","allowedDomains"]){const a=p.value[key];if(!Array.isArray(a)||a.some(v=>typeof v!=="string"))return;}
 return {target:target.value as unknown as ExecutionTarget,profile:profile.value as unknown as CanonicalProfile,work:d.work,jobRoot:d.jobRoot,protectedPaths:paths.value as string[]};
}
