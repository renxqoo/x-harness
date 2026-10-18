import type {ExecutionTarget,ExecutionOutput,ExecutionResult} from "../../execution/src/index";
export interface ProcessProfile {readonly cwd:string;readonly readRoots?:readonly string[];readonly writeRoots?:readonly string[];readonly env?:Readonly<Record<string,string>>;readonly allowEnv?:readonly string[];readonly allowedDomains?:readonly string[]}
export interface ProcessLimits {readonly maxActiveRequests:number;readonly timeoutMs:number;readonly maxOutputBytes:number;readonly maxScanEntries:number}
export interface ProcessExecutionOptions {readonly profiles:Readonly<Record<string,ProcessProfile>>;readonly limits?:Partial<ProcessLimits>}
export interface CanonicalProfile {readonly cwd:string;readonly readRoots:readonly string[];readonly writeRoots:readonly string[];readonly env:Readonly<Record<string,string>>;readonly allowEnv:readonly string[];readonly allowedDomains:readonly string[]}
export interface FileIdentity {readonly path:string;readonly dev:number;readonly ino:number;readonly size:number;readonly mtimeMs:number;readonly ctimeMs:number}
export interface ProcessTarget {readonly target:ExecutionTarget;readonly identities:readonly FileIdentity[];readonly profile:CanonicalProfile;readonly scratch:string;used:boolean}
export interface ProcessRunnerInput {readonly target:ExecutionTarget;readonly profile:CanonicalProfile;readonly scratch:string;readonly root:string;readonly signal:AbortSignal;readonly limits:ProcessLimits}
export type ProcessRunner=(input:ProcessRunnerInput)=>Promise<ExecutionResult<ExecutionOutput>>;
