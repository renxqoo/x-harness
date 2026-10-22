import { expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

it.each(["active", "first"])("a changed stable SDK dependency requires restart before %s Loader activation without accepting a new generation", async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), "loader-sdk-restart-")); const sdk = join(directory, "sdk"); const source = new URL("../../../", import.meta.url).pathname;
  try {
    await cp(source, sdk, { recursive: true, filter: (path) => !["node_modules", "dist", "__test__", "reviews", "coverage", "fixtures", "scripts"].includes(basename(path)) });
    await symlink(join(source, "node_modules"), join(sdk, "node_modules"));
    await cp(join(source, "loader/dist"), join(sdk, "loader/dist"), { recursive: true });
    const plugin = join(directory, "plugin.ts"); await writeFile(plugin, 'export default{name:"retained",setup(){return{ok:true,value:undefined}}}');
    const program = join(directory, "verify.ts");
    const before = mode === "first" ? `await appendFile(${JSON.stringify(join(sdk, "plugins/tools/src/contracts/types.ts"))},"\\n");const rejected=await createLoader({entries:[${JSON.stringify(plugin)}]});if(rejected.ok)await rejected.value.close();assert.equal(rejected.ok,false);assert.equal(rejected.error.code,"restart-required");assert.equal(rejected.error.phase,"sdk");process.stdout.write("passed\\n");process.exit(0);` : "";
    await writeFile(program, `import assert from"node:assert/strict";import{appendFile}from"node:fs/promises";import{createLoader}from ${JSON.stringify(join(sdk, "loader/src/index.ts"))};${before}const loaded=await createLoader({entries:[${JSON.stringify(plugin)}],watch:true,debounceMs:1});assert.equal(loaded.ok,true);if(!loaded.ok)throw 1;const loader=loaded.value;try{await appendFile(${JSON.stringify(join(sdk, "plugins/tools/src/contracts/types.ts"))},"\\n");for(let i=0;i<100&&loader.status().state!=="restart-required";i++)await Bun.sleep(10);assert.equal(loader.status().state,"restart-required");assert.equal(loader.status().error.phase,"sdk");assert.equal((await loader.reload()).error.phase,"sdk");assert.equal(loader.status().imports,1);assert.equal(loader.snapshot().plugins[0].state,"active");for(const api of [{createLoader},await import(${JSON.stringify(join(sdk, "loader/dist/index.js"))})]){const reopened=await api.createLoader({entries:[${JSON.stringify(plugin)}]});if(reopened.ok)await reopened.value.close();assert.equal(reopened.ok,false);assert.equal(reopened.error.code,"restart-required");assert.equal(reopened.error.phase,"sdk");}}finally{assert.equal((await loader.close()).ok,true)}process.stdout.write("passed\\n");`);
    const child = Bun.spawn(["bun", program], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 5000);
    try { const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "passed\n", stderr: "" }); }
    finally { clearTimeout(timeout); child.kill(); }
    expect((await readFile(join(sdk, "plugins/tools/src/contracts/types.ts"), "utf8")).endsWith("\n\n")).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
