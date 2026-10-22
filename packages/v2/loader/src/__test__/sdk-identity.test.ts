import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLoader } from "../index";
import { tools } from "../../../plugins/tools/src/index";
import { agentLoop } from "../../../plugins/agent-loop/src/index";
import { project, value } from "./helpers";

it.each(["source", "built"])(
  "official Tools tokens stay shared across %s loader entries and private implementation reloads",
  async (mode) => {
    const p = await project();
    const root = new URL("../../../", import.meta.url).pathname;
    const api =
      mode === "built"
        ? ((await import(new URL("../../dist/index.js", import.meta.url).href)) as {
            createLoader: typeof createLoader;
          })
        : { createLoader };

    try {
      const registry = join(p.privateDir, "registry.ts");
      const contribution = join(p.privateDir, "contribution.ts");
      const dependency = join(p.privateDir, "value.ts");
      await writeFile(
        registry,
        'import {createToolsPlugin} from "@x-harness/tools";const result=createToolsPlugin({access:"allow"});if(!result.ok)throw 1;export default result.value;',
      );
      await writeFile(dependency, 'export const text="first"');
      await writeFile(
        contribution,
        `import {createToolPlugin} from ${JSON.stringify(join(root, "plugins/tools/dist/index.js"))};import{text}from"./value";const result=createToolPlugin({name:"echo",inputSchema:{type:"object",additionalProperties:false},async execute(){return{ok:true,value:{content:[{type:"text",text}]}}}});if(!result.ok)throw 1;export default result.value;`,
      );
      const loader = value(
        await api.createLoader({
          entries: [registry, contribution],
          application: { host: { limits: { maxCallDepth: 256 } } },
        }),
      );

      try {
        expect(loader.snapshot().plugins.map((entry) => entry.state)).toEqual(["active", "active"]);

        const execute = () =>
          value(loader.use(tools)).execute({ name: "echo", callId: "echo-call", input: {} });

        expect(value(await execute()).content).toEqual([{ type: "text", text: "first" }]);
        await writeFile(dependency, 'export const text="second"');
        value(await loader.reload());
        expect(value(await execute()).content).toEqual([{ type: "text", text: "second" }]);
        expect(loader.status().imports).toBe(3);
      } finally {
        value(await loader.close());
      }
    } finally {
      await p.close();
    }
  },
);

it.each(["source", "built"])(
  "official Agent and LLM public contracts compose through %s loader entries and reload",
  async (mode) => {
    const p = await project();
    const root = new URL("../../../", import.meta.url).pathname;
    const api =
      mode === "built"
        ? ((await import(new URL("../../dist/index.js", import.meta.url).href)) as {
            createLoader: typeof createLoader;
          })
        : { createLoader };

    try {
      await writeFile(
        p.contract,
        `import{defineLlmProvider}from ${JSON.stringify(join(root, "plugins/llm/src/index.ts"))};const result=defineLlmProvider("loader-test");if(!result.ok)throw 1;export const provider=result.value;`,
      );
      const sources = {
        provider:
          'import{createLlmProviderPlugin}from"@x-harness/llm/provider";import{provider}from"contracts";const result=createLlmProviderPlugin({token:provider,models:{test:{model:"test",protocol:"test",input:["text"],developer:true,tools:true,citations:false,output:["text"],providerTools:[],reasoning:{efforts:[],budget:false,display:[]}}},async run(input){const receipt=input.request.messages.find(message=>message.role==="tool");const events=receipt?[{type:"block-start",block:{id:"text",kind:"text"}},{type:"text-delta",id:"text",delta:"complete"},{type:"block-end",id:"text",status:"complete"}]:[{type:"block-start",block:{id:"tool",kind:"tool-call"}},{type:"tool-call-delta",id:"tool",field:"callId",delta:"echo-call"},{type:"tool-call-delta",id:"tool",field:"name",delta:"echo"},{type:"tool-call-delta",id:"tool",field:"input",delta:"{}"},{type:"block-end",id:"tool",status:"complete"}];for(const event of events){const sent=await input.onEvent(event);if(!sent.ok)return sent;}return{ok:true,value:{reason:{kind:receipt?"stop":"tool-calls"}}};}});if(!result.ok)throw 1;export default result.value;',
        llm: `import{createLlmPlugin}from ${JSON.stringify(join(root, "plugins/llm/dist/index.js"))};import{provider}from"contracts";const result=createLlmPlugin({providers:{local:provider},defaultProvider:"local"});if(!result.ok)throw 1;export default result.value;`,
        registry:
          'import{createToolsPlugin}from"@x-harness/tools";const result=createToolsPlugin({access:"allow"});if(!result.ok)throw 1;export default result.value;',
        scheduler: `import{createToolSchedulerPlugin}from ${JSON.stringify(join(root, "plugins/tool-scheduler/dist/index.js"))};const result=createToolSchedulerPlugin({access:"allow"});if(!result.ok)throw 1;export default result.value;`,
        tool: 'import{createToolPlugin}from"@x-harness/tools";import{text}from"./value";const result=createToolPlugin({name:"echo",inputSchema:{type:"object",additionalProperties:false},async execute(){return{ok:true,value:{content:[{type:"text",text}]}}}});if(!result.ok)throw 1;export default result.value;',
        loop: `import{createAgentLoopPlugin}from ${JSON.stringify(join(root, "plugins/agent-loop/dist/index.js"))};const result=createAgentLoopPlugin({access:"allow"});if(!result.ok)throw 1;export default result.value;`,
      };
      const entries: string[] = [];

      for (const [name, source] of Object.entries(sources)) {
        const path = join(p.privateDir, name + ".ts");
        await writeFile(path, source);
        entries.push(path);
      }

      const dependency = join(p.privateDir, "value.ts");
      await writeFile(dependency, 'export const text="first"');
      const loader = value(
        await api.createLoader({
          ...p.options,
          entries,
          application: { host: { limits: { maxCallDepth: 256, callTimeoutMs: 10000 } } },
        }),
      );

      try {
        expect(loader.snapshot().plugins.every((entry) => entry.state === "active")).toBe(true);

        const run = () =>
          value(loader.use(agentLoop)).run({
            model: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "echo" }] }],
          });

        const first = value(await run());
        expect([first.steps, first.toolCalls]).toEqual([2, 1]);
        expect(JSON.stringify(first.messages)).toContain('"text":"first"');
        await writeFile(dependency, 'export const text="second"');
        value(await loader.reload());
        const second = value(await run());
        expect([second.steps, second.toolCalls]).toEqual([2, 1]);
        expect(JSON.stringify(second.messages)).toContain('"text":"second"');
        expect(loader.status().imports).toBe(7);
        expect(loader.inspect()).toMatchObject({ activeCalls: 0, activeTasks: 0 });
      } finally {
        value(await loader.close());
      }
    } finally {
      await p.close();
    }
  },
);
