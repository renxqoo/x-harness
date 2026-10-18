import { readData } from "../../../../core/src/validation";
export function object(raw:unknown):raw is Record<string,unknown> { return !!raw && typeof raw==="object" && !Array.isArray(raw); }
export function keys(raw:Record<string,unknown>,allowed:readonly string[]):boolean { return Object.keys(raw).every(k=>allowed.includes(k)); }
export function name(raw:unknown):raw is string { return typeof raw==="string" && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(raw); }
export function data(raw:unknown) { const result=readData(raw);return result.ok?result.value:undefined; }
