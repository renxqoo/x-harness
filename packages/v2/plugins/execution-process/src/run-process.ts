import {observeSignal,signalAborted} from "../../../core/src/validation";
import type {ExecutionResult,ExecutionOutput} from "../../execution/src/index";
import type {ProcessOptions} from "./read-process-options";
import {readProcessOptions} from "./read-process-options";
import {fail} from "./fail";
import {waitProcessGroup} from "./wait-process-group";
export async function runProcess(raw:ProcessOptions):Promise<ExecutionResult<ExecutionOutput>>{
 const parsed=readProcessOptions(raw);if(!parsed.ok)return parsed;const options=parsed.value;
 if(signalAborted(options.signal))return fail("cancelled");
 let child:Bun.Subprocess<"pipe"|"ignore","pipe","pipe">;
 let killTimer:ReturnType<typeof setTimeout>|undefined,limited=false,failed=false,bytes=0;
 const kill=(signal:NodeJS.Signals)=>{try{process.kill(-child.pid,signal);}catch{}};
 const terminate=()=>{kill("SIGTERM");if(!killTimer)killTimer=setTimeout(()=>kill("SIGKILL"),100);};
 try{child=Bun.spawn([...options.argv],{cwd:options.cwd,env:{...options.env},stdin:options.stdin===undefined?"ignore":"pipe",stdout:"pipe",stderr:"pipe",detached:true,...(options.onMessage?{ipc(message:unknown){try{options.onMessage!(message);}catch{failed=true;terminate();}}}:{})});}catch{return fail("execution-failed");}
 const off=observeSignal(options.signal,terminate);if(signalAborted(options.signal))terminate();
 const read=async(stream:ReadableStream<Uint8Array>)=>{const reader=stream.getReader(),decoder=new TextDecoder();let result="";try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>options.maxOutputBytes){limited=true;kill("SIGKILL");continue;}result+=decoder.decode(next.value,{stream:true});}return result+decoder.decode();}catch{failed=true;terminate();return "";}finally{reader.releaseLock();}};
 const write=async()=>{if(options.stdin!==undefined&&child.stdin){try{await child.stdin.write(options.stdin);await child.stdin.end();}catch{failed=true;terminate();}}};
 try{
  const [stdout,stderr,exitCode]=await Promise.all([read(child.stdout),read(child.stderr),child.exited.then(code=>{terminate();return code;}),write()]);
  await waitProcessGroup(child.pid);
  if(signalAborted(options.signal))return fail("cancelled");if(limited||new TextEncoder().encode(stdout+stderr).length>options.maxOutputBytes)return fail("output-limit");if(failed)return fail("execution-failed");return {ok:true,value:{exitCode,stdout,stderr}};
 }finally{off();if(killTimer)clearTimeout(killTimer);}
}
