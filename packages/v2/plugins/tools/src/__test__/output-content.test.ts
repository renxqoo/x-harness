import { expect,it } from "vitest";
import { createToolPlugin } from "../index";
import { world,value,request,emptySchema } from "./helpers";
it.each([
 null,{type:"text",text:"x",extra:true},{type:"image",source:null},{type:"image",source:{type:"url",url:1}},
 {type:"image",source:{type:"url",url:"not a URL"}},{type:"image",source:{type:"url",url:"https://example.com",extra:1}},
 {type:"image",source:{type:"base64",mediaType:"image/png",data:""}},{type:"image",source:{type:"base64",mediaType:"image/png",data:"a"}},
 {type:"image",source:{type:"base64",mediaType:"image/png",data:"===="}},{type:"image",source:{type:"unknown"}}, {type:"unknown"},
])("malformed content blocks fail without leaking their payload %#",async block=>{const {host,service}=await world([value(createToolPlugin({name:"echo",inputSchema:emptySchema,execute:async()=>({ok:true,value:{content:[block as never]}})}))]);try{expect(await service.execute(request())).toMatchObject({ok:false,error:{code:"invalid-output"}});}finally{value(await host.close());}});
it("image URLs stay data and are not fetched by the tool registry",async()=>{const output={content:[{type:"image" as const,source:{type:"url" as const,url:"https://example.invalid/image.png"}}]};const {host,service}=await world([value(createToolPlugin({name:"echo",inputSchema:emptySchema,execute:async()=>({ok:true,value:output})}))]);try{expect(value(await service.execute(request()))).toEqual(output);}finally{value(await host.close());}});
