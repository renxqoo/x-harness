import type { Result } from "../../../../core/src/index";
import { readData } from "../../../../core/src/validation";
export function propagateCancellation<T,E>(result:Result<T,E>,cancel:(reason:"cancelled"|"timeout")=>void):Result<T,E>{if(!result.ok){const error=readData(result.error);if(error.ok&&error.value.source==="core"&&(error.value.code==="cancelled"||error.value.code==="timeout"))cancel(error.value.code);}return result;}
