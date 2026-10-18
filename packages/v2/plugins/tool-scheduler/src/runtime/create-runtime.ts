import type { SchedulerLimits } from "../contracts/types";
import type { Runtime } from "./types";
import { pumpQueue } from "./pump-queue";
export function createRuntime(limits:SchedulerLimits):Runtime{const runtime:Runtime={wake:()=>pumpQueue(runtime),limits,batches:new Set(),queue:[],lanes:[],streak:new Map(),toolActive:new Map(),running:0,outstanding:0,requests:0,pumping:false,closed:false};return runtime;}
