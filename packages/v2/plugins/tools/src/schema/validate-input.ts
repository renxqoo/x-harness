import {readDescription} from "../domain/read-description";
import { compileDescription } from "./compile-description";
import { readJson } from "../domain/read-json";
import { maximumToolsLimits } from "../domain/read-limits";
import { fail } from "../domain/fail";
import type { ToolDescription,ToolsResult } from "../contracts/types";
export function validateToolInput(tool:ToolDescription,input:unknown):ToolsResult<void>{const snapshot=readDescription(tool);if(!snapshot.ok)return fail("invalid-schema");const compiled=compileDescription(snapshot.value);if(!compiled.ok)return compiled;const parsed=readJson(input,{maxBytes:maximumToolsLimits.maxInputBytes});if(!parsed.ok)return parsed;return compiled.value.input(parsed.value)?{ok:true,value:undefined}:fail("invalid-input");}
