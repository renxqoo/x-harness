import type { ToolEffects,ToolExecutionPlan } from "./planning/types";
import type { ExecutionFacade } from "../../execution/src/index";
import {readEffects} from "./planning/read-effects";
import { defineChain } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";
import type { Origin } from "../../../core/src/index";
import type { ToolDescription,ToolRequest,ToolOutput,ToolsError,ToolsResult,ToolsLimits } from "./contracts/types";
import { data,keys } from "./domain/read-values";
import { readOutput } from "./domain/read-output";
import { maximumToolsLimits } from "./domain/read-limits";
export interface CatalogEntry {readonly id:string;readonly signal:AbortSignal;readonly tool:ToolDescription;readonly bytes:number}
export interface CatalogQuery {readonly visit:(entry:CatalogEntry)=>ToolsResult<void>}
export interface Ticket {readonly ticket: true}
export interface TicketData {readonly plan?:ToolExecutionPlan;readonly execution?:ExecutionFacade;readonly entry:CatalogEntry;readonly request:ToolRequest;readonly caller:Origin;readonly limits:ToolsLimits;readonly cancel:(reason:"cancelled"|"timeout")=>void}
const entries=new WeakSet<CatalogEntry>();const tickets=new WeakMap<Ticket,TicketData>();
export function makeEntry(tool:ToolDescription,signal:AbortSignal):CatalogEntry{const entry=Object.freeze({id:crypto.randomUUID(),signal,tool,bytes:new TextEncoder().encode(JSON.stringify(tool)).length});entries.add(entry);return entry;}
export function knownEntry(raw:CatalogEntry){return entries.has(raw);}
export function makeTicket(value:TicketData):Ticket{const ticket=Object.freeze({ticket:true as const});tickets.set(ticket,value);return ticket;}
export function ticketData(ticket:Ticket){return tickets.get(ticket);}
export function closeTicket(ticket:Ticket){tickets.delete(ticket);}
const catalog=defineChain<CatalogQuery,void,ToolsError>({name:"tools/catalog",input(raw){const d=data(raw);return d&&keys(d,["visit"])&&typeof d.visit==="function"?{ok:true,value:raw as CatalogQuery}:createFault("invalid-input");},output:raw=>raw===undefined?{ok:true,value:undefined}:createFault("invalid-result")});if(!catalog.ok)throw new Error("Invalid tool catalog definition");export const toolCatalog=catalog.value;
const dispatch=defineChain<Ticket,ToolOutput,ToolsError>({name:"tools/dispatch",input:raw=>raw&&typeof raw==="object"&&tickets.has(raw as Ticket)?{ok:true,value:raw as Ticket}:createFault("invalid-input"),output(raw){const result=readOutput(raw,maximumToolsLimits.maxOutputBytes);return result.ok?result:createFault("invalid-result");}});if(!dispatch.ok)throw new Error("Invalid tool dispatch definition");export const toolDispatch=dispatch.value;

const preparation=defineChain<Ticket,ToolEffects,ToolsError>({name:"tools/prepare",input:raw=>raw&&typeof raw==="object"&&tickets.has(raw as Ticket)?{ok:true,value:raw as Ticket}:createFault("invalid-input"),output(raw){const result=readEffects(raw);return result.ok?result:createFault("invalid-result");}});if(!preparation.ok)throw new Error("Invalid preparation definition");export const toolPreparation=preparation.value;
