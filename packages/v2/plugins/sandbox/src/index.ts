import {createProcessExecutionPlugin} from "../../execution-process/src/index";
import type {ProcessExecutionOptions} from "../../execution-process/src/index";
import {systemReadRoots} from "./system-read-roots";
import {runSandbox} from "./run-sandbox";
export type {ProcessProfile,ProcessExecutionOptions,ProcessLimits} from "../../execution-process/src/index";
export function createSandboxPlugin(options:ProcessExecutionOptions){return createProcessExecutionPlugin(options,{name:"sandbox",isolation:"seatbelt-single-process",systemReadRoots,run:runSandbox});}
