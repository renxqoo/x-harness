import { readData } from "../../../../core/src/validation";
import { readResources } from "../../../execution/src/index";
import { readJson } from "../domain/read-json";
import { fail } from "../domain/fail";
import type { ToolEffects } from "./types";
export function readEffects(raw:unknown){const json=readJson(raw,{maxBytes:65536});if(!json.ok)return fail("invalid-input");const parsed=readData(json.value);if(!parsed.ok)return fail("invalid-input");const d=parsed.value;if(Object.keys(d).some(k=>!["actions","resources","execution"].includes(k)))return fail("invalid-input");const actions=readData(d.actions===undefined?{}:d.actions),resources=readResources(d.resources===undefined?[]:d.resources);if(!actions.ok||!resources.ok)return fail("invalid-input");if(d.execution!==undefined){const e=readData(d.execution);if(!e.ok||Object.keys(e.value).some(k=>!["profile","argv","cwd","env"].includes(k)))return fail("invalid-input");}return {ok:true as const,value:Object.freeze({...d,actions:actions.value,resources:resources.value}) as unknown as ToolEffects};}
