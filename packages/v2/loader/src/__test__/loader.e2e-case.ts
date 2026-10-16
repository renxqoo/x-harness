import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createLoader } from "../index";
import type { ServiceToken, Result } from "../../../core/src/index";
import { project, value } from "./helpers";

const mode = process.argv[2]; const p = await project();
process.env.TMPDIR = p.root;
const temporary = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("x-harness-module-")));
try {
  if (mode === "budget") {
    const loader = value(await createLoader(p.options));
    for (let iteration = 1; iteration < 64; iteration += 1) { await p.write(String(iteration)); value(await loader.reload()); }
    await p.write("overflow"); assert.equal((await loader.reload()).ok, false); assert.equal(loader.status().state, "restart-required");
    assert.equal(loader.status().imports, 64); assert.equal(value(await value(loader.use(await p.token())).read()), "63"); value(await loader.close());
    const exhausted = await createLoader(p.options); assert.equal(exhausted.ok, false); if (!exhausted.ok) assert.equal(exhausted.error.code, "restart-required");
    const built = await import(new URL("../../dist/index.js", import.meta.url).href) as { createLoader: typeof createLoader };
    const exhaustedCopy = await built.createLoader(p.options); assert.equal(exhaustedCopy.ok, false); if (!exhaustedCopy.ok) assert.equal(exhaustedCopy.error.code, "restart-required");
  } else {
    await writeFile(p.contract, await readFile(p.contract, "utf8") + ';const http=defineService({name:"example/http",methods:{url:{}}});if(!http.ok)throw 1;export const endpoint=http.value;');
    const gateway = join(p.privateDir, "gateway.ts");
    await writeFile(gateway, `import{token,endpoint}from"contracts";export default{name:"gateway",requires:{token},provides:{endpoint},async setup(ctx){
      const opened=await ctx.resource({open(){return{ok:true,value:Bun.serve({port:0,hostname:"127.0.0.1",async fetch(){const task=ctx.startTask({label:"http-read",run(call){return call.deps.token.read()}});if(!task.ok)return new Response("stopping",{status:503});const result=await task.value.finished;return Response.json(result)}})}},async close(server){await server.stop(true);return{ok:true,value:undefined}}});
      if(!opened.ok)return opened;return ctx.service({endpoint:{async url(){return{ok:true,value:opened.value.url.href}}}})}}`);
    const api = mode === "built" ? await import(new URL("../../dist/index.js", import.meta.url).href) as { createLoader: typeof createLoader } : { createLoader };
    const loader = value(await api.createLoader({ ...p.options, entries: [gateway, p.entry], watch: true, debounceMs: 5 }));
    const contracts = await import(pathToFileURL(p.contract).href) as { endpoint: ServiceToken<{ url(input: void): Promise<Result<string>> }> };
    const address = async () => value(await value(loader.use(contracts.endpoint)).url());
    const first = await address(); assert.deepEqual(await (await fetch(first)).json(), { ok: true, value: "one" });
    await p.write("updated");
    let current = first;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const handle = loader.use(contracts.endpoint);
      if (handle.ok) { const result = await handle.value.url(); if (result.ok) current = result.value; }
      if (current !== first) break; await Bun.sleep(5);
    }
    assert.notEqual(current, first); assert.deepEqual(await (await fetch(current)).json(), { ok: true, value: "updated" });
    await assert.rejects(fetch(first));
    await writeFile(p.entry, "syntax error {"); assert.equal((await loader.reload()).ok, false);
    assert.deepEqual(await (await fetch(current)).json(), { ok: true, value: "updated" });
    value(await loader.close()); assert.equal(loader.inspect().effects, 0); assert.equal(loader.inspect().activeTasks, 0); await assert.rejects(fetch(current));
  }
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("x-harness-module-") && !temporary.has(name)), []);
  process.stdout.write("passed\n");
} finally { await p.close(); }
