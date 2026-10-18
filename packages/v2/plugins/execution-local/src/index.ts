import {createProcessExecutionPlugin,runProcess} from "../../execution-process/src/index";
import type {ProcessExecutionOptions} from "../../execution-process/src/index";
export type {ProcessProfile,ProcessExecutionOptions,ProcessLimits} from "../../execution-process/src/index";
export function createLocalExecutionPlugin(options:ProcessExecutionOptions){return createProcessExecutionPlugin(options,{name:"execution-local",isolation:"none",run:input=>runProcess({argv:input.target.argv,cwd:input.target.cwd,env:input.target.env,signal:input.signal,maxOutputBytes:input.limits.maxOutputBytes})});}
