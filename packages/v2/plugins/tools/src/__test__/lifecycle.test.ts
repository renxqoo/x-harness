import { expect, it } from "vitest";
import { createHost, definePlugin } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { createToolsPlugin, createToolPlugin, tools, toolAccess } from "../index";
function value<T,E>(r: Result<T,E>): T { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; }
const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } as const;
function echo(name = "echo") { return value(createToolPlugin({ name, inputSchema: schema, execute: async (input) => ({ ok: true, value: { content: [{ type: "text", text: input.text }] } }) })); }
it("dynamic installation and removal immediately change discovery and execution", async () => {
  const host = value(createHost());
  try {
    value(await host.install([value(createToolsPlugin({ access: "allow" }))]));
    const service = value(host.use(tools)); expect(value(await service.list({}))).toEqual([]);
    const loaded = value(await host.install([echo()]));
    expect(value(await service.list({})).map(x => x.name)).toEqual(["echo"]);
    expect(value(await service.get({ name: "echo" }))?.inputSchema).toEqual(schema);
    expect(value(await service.execute({ name: "echo", callId: "a", input: { text: "hi" } }))).toEqual({ content: [{ type: "text", text: "hi" }] });
    value(await host.uninstall(loaded.plugins[0]!));
    expect(value(await service.get({ name: "echo" }))).toBeNull();
    expect(await service.execute({ name: "echo", callId: "b", input: {} })).toMatchObject({ ok: false, error: { code: "not-found" } });
  } finally { value(await host.close()); }
});
it("schema rejects invalid input before the author can produce a side effect", async () => {
  const host = value(createHost()); let calls=0;
  try {
    value(await host.install([value(createToolsPlugin({ access: "allow" })),value(createToolPlugin({name:"typed",inputSchema:schema,execute:async()=>{calls++;return {ok:true,value:{content:[]}};}}))]));
    const service=value(host.use(tools));
    for(const input of [{text:3},{text:"x",extra:true},{}]) expect(await service.execute({name:"typed",callId:"a",input:input as never})).toMatchObject({ok:false,error:{code:"invalid-input"}});
    expect(calls).toBe(0);
  } finally {value(await host.close());}
});
it("missing authorization denies list get and execute until an explicit policy is installed", async()=>{
  const host=value(createHost());
  try{
    value(await host.install([value(createToolsPlugin()),echo()])); const service=value(host.use(tools));
    expect(value(await service.list({}))).toEqual([]);expect(value(await service.get({name:"echo"}))).toBeNull();expect(await service.execute({name:"echo",callId:"x",input:{text:"x"}})).toMatchObject({ok:false,error:{code:"access-denied"}});
    value(await host.install([definePlugin({name:"allow",requires:{toolAccess},setup(ctx){return ctx.guard("toolAccess",()=>({ok:true,value:{kind:"allow"}}));}})]));
    expect(value(await service.list({}))).toHaveLength(1);expect((await service.execute({name:"echo",callId:"x",input:{text:"x"}})).ok).toBe(true);
  }finally{value(await host.close());}
});
it("a failed installation cannot publish a partial tool contribution",async()=>{
  const host=value(createHost());
  try{value(await host.install([value(createToolsPlugin({access:"allow"}))]));expect((await host.install([echo(),definePlugin({name:"failed",setup:()=>({ok:false,error:"failed"})})])).ok).toBe(false);expect(value(await value(host.use(tools)).list({}))).toEqual([]);}finally{value(await host.close());}
});
it.each(["read_file","URLFetch","_hidden","a--b"])("valid tool name %s maps to a valid collision-free core plugin identity",async name=>{const host=value(createHost());try{value(await host.install([value(createToolsPlugin({access:"allow"})),echo(name)]));expect(value(await value(host.use(tools)).execute({name,callId:"a",input:{text:"ok"}})).content).toEqual([{type:"text",text:"ok"}]);}finally{value(await host.close());}});
