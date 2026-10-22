import { expect, it } from "vitest";

it("SDK public package names resolve to one core identity in native Bun applications", async () => {
  const source = `import {definePlugin,defineService} from "@x-harness/core";
    import {createApplication} from "@x-harness/application";
    import {createTimerPlugin} from "@x-harness/standard";
    import {createLoader} from "@x-harness/loader";
    import {createProject} from "@x-harness/create";
    const token=defineService({name:"public/test",methods:{read:{}}});if(!token.ok)throw 1;
    const created=createApplication();if(!created.ok)throw 1;const app=created.value;
    try{const timer=createTimerPlugin();if(!timer.ok)throw 1;
      const loaded=await app.setPlugins([timer.value,definePlugin({name:"provider",provides:{token:token.value},setup(ctx){return ctx.service({token:{async read(){return{ok:true,value:"shared"}}}})}})]);if(!loaded.ok)throw 1;
      const service=app.use(token.value);if(!service.ok)throw 1;
      const result=await service.value.read();if(!result.ok)throw 1;
      process.stdout.write(JSON.stringify({value:result.value,loader:typeof createLoader,create:typeof createProject}));
    }finally{const closed=await app.close();if(!closed.ok)throw 1}`;
  const child = Bun.spawn(["bun", "--eval", source], {
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ stdout, stderr, status }).toEqual({
    stdout: '{"value":"shared","loader":"function","create":"function"}',
    stderr: "",
    status: 0,
  });
});
