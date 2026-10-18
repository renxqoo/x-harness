import {readIdentity} from "./read-identity";
import type {ProcessTarget} from "./types";
import {fail} from "./fail";
export async function checkTarget(data:ProcessTarget){try{for(const identity of data.identities){const current=await readIdentity(identity.path);if(current.dev!==identity.dev||current.ino!==identity.ino)return fail("target-changed");if(identity.path===data.target.argv[0]&&(current.size!==identity.size||current.mtimeMs!==identity.mtimeMs||current.ctimeMs!==identity.ctimeMs))return fail("target-changed");}return {ok:true as const,value:undefined};}catch{return fail("target-changed");}}
