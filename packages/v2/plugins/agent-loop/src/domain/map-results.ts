import type {BatchReport} from "../../../tool-scheduler/src/index";
import type {AgentToolReceipt} from "../contracts/types";
import {mapReceipts} from "./map-receipts";
export function mapResults(report:BatchReport){const results:AgentToolReceipt[]=report.results.map(item=>item.result.ok?{callId:item.callId,outcome:"returned",output:item.result.value}:{callId:item.callId,outcome:"unknown",error:{source:item.result.error.source,code:item.result.error.code}});return {results,messages:mapReceipts(results),unknown:results.some(result=>result.outcome==="unknown")};}
