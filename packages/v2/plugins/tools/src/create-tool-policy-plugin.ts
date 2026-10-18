import { definePlugin } from "../../../core/src/index";
import type { TokenMap,Plugin } from "../../../core/src/index";
import { readData,normalizeResult } from "../../../core/src/validation";
import { toolExecutionAccess } from "./contracts";
import { policyCells } from "./planning/shared";
import type { ToolPolicyOptions,ToolPermission } from "./planning/types";
import { data,keys,name } from "./domain/read-values";
import { fail } from "./domain/fail";
import type { ToolsResult } from "./contracts/types";
export function createToolPolicyPlugin<D extends TokenMap=Record<never,never>,O extends TokenMap=Record<never,never>>(raw:ToolPolicyOptions<D,O>):ToolsResult<Plugin>{const d=data(raw);if(!d||!keys(d,["name","requires","optional","authorize"])||!name(d.name)||typeof d.authorize!=="function")return fail("invalid-input");const requires=data(d.requires??{}),optional=data(d.optional??{});if(!requires||!optional||"toolExecutionAccess"in requires||"toolExecutionAccess"in optional)return fail("invalid-input");const authorize=d.authorize as typeof raw.authorize;
 return {ok:true,value:definePlugin({name:`tool-policy/${d.name}`,requires:{...(requires as Record<never,never>),toolExecutionAccess},optional:optional as Record<never,never>,setup:ctx=>ctx.guard("toolExecutionAccess",async(plan,call)=>{const deny={ok:true as const,value:{kind:"deny" as const,reason:"access-denied"}};let result:unknown;try{result=await authorize(plan,call as never);}catch{return deny;}const parsed=normalizeResult(result);if(!parsed.ok)return deny;const permission=readData(parsed.value);if(!permission.ok||Object.keys(permission.value).some(k=>!["kind","signal","isValid"].includes(k)))return deny;const p=permission.value as unknown as ToolPermission;if(p.kind!=="allow")return deny;if(p.isValid!==undefined&&typeof p.isValid!=="function")return deny;if(p.signal!==undefined){try{Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")!.get!.call(p.signal);}catch{return deny;}}
 const cell=policyCells.get(plan);if(!cell?.checking||call.signal.aborted||ctx.signal.aborted)return deny;cell.permissions.push({kind:"allow",signal:ctx.signal},p);return {ok:true,value:{kind:"allow"}};
 })})};
}
