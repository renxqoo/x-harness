import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Result } from "../../../core/src/index";

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

export async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kernel-loader-test-")));
  const shared = join(root, "shared");
  const privateDir = join(root, "private");
  await mkdir(shared);
  await mkdir(privateDir);
  const entry = join(privateDir, "plugin.ts");
  const contract = join(shared, "contract.ts");
  const core = new URL("../../../core/src/index.ts", import.meta.url).pathname;
  await writeFile(
    contract,
    `import {defineService} from ${JSON.stringify(core)}; const result = defineService({name:"example/value",methods:{read:{}}}); if(!result.ok)throw new Error("contract"); export const token=result.value;`,
  );

  const write = async (text: string) =>
    writeFile(
      entry,
      `import {definePlugin} from ${JSON.stringify(core)};import{token}from"contracts";export default definePlugin({name:"example",provides:{token},setup(ctx){return ctx.service({token:{async read(){return{ok:true,value:${JSON.stringify(text)}}}}})}});`,
    );

  await write("one");
  return {
    root,
    shared,
    privateDir,
    entry,
    contract,
    core,
    write,
    options: { entries: [entry], shared: { contracts: { path: contract, directory: shared } } },
    token: async () =>
      (
        (await import(pathToFileURL(contract).href)) as {
          token: import("../../../core/src/index").ServiceToken<{
            read(input: void): Promise<Result<string>>;
          }>;
        }
      ).token,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
