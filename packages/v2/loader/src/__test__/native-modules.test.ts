import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { createLoader } from "../index";
import { checkBundle } from "../check-bundle";
import { project, value } from "./helpers";

it.each(["node:path", "path", "bun:sqlite"])(
  "a real plugin can import the runtime native module %s without a false build failure",
  async (specifier) => {
    const p = await project();

    try {
      const native =
        specifier === "bun:sqlite"
          ? `import{Database}from${JSON.stringify(specifier)};const read=()=>{const database=new Database(":memory:");try{return database.query("select 'native-result' as value").get().value}finally{database.close()}};`
          : `import{basename}from${JSON.stringify(specifier)};const read=()=>basename("/temporary/native-result");`;
      await writeFile(
        p.entry,
        `${native}import{token}from"contracts";export default{name:"native",provides:{token},setup(ctx){return ctx.register(token,{async read(){return{ok:true,value:read()}}})}}`,
      );
      const loader = value(await createLoader(p.options));

      try {
        expect(value(await value(loader.use(await p.token())).read())).toBe("native-result");
        value(await loader.reload());
        expect(loader.status().imports).toBe(1);
      } finally {
        value(await loader.close());
      }
    } finally {
      await p.close();
    }
  },
);

it("forged native module prefixes are rejected without replacing the active service or spending imports", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));

    try {
      for (const specifier of [
        "node:loader-module-does-not-exist",
        "bun:loader-module-does-not-exist",
        "node:fs/../../private",
        "bun:sqlite/../../private",
        "node:bun:ffi",
        "node:bun:jsc",
        "node:bun:sqlite",
        "node:bun:test",
        "node:bun",
        "node:node:sqlite",
        "node:undici",
        "node:ws",
      ]) {
        await writeFile(
          p.entry,
          `import * as dependency from ${JSON.stringify(specifier)};export default dependency`,
        );
        expect(await loader.reload()).toMatchObject({
          ok: false,
          error: { code: "build-failed", phase: "build", entryIndex: 0 },
        });
        expect(loader.status().imports).toBe(1);
        expect(value(await value(loader.use(await p.token())).read())).toBe("one");
      }
    } finally {
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});

it("bundle validation accepts only real native static imports and keeps dynamic and undeclared dependencies rejected", () => {
  for (const source of [
    'import {basename} from "path"',
    'import {basename} from "node:path"',
    'export {Database} from "bun:sqlite"',
    'const sqlite=require("bun:sqlite")',
    'import "bun:ffi"',
    'import "bun:jsc"',
    'import "bun:test"',
    'import "bun"',
    'import "node:sqlite"',
    'import "undici"',
    'import "ws"',
  ]) {
    expect(checkBundle(source, new Set())).toBe(true);
  }

  for (const source of [
    'import "node:loader-module-does-not-exist"',
    'import "bun:loader-module-does-not-exist"',
    'import "node:fs/../../private"',
    'import "bun:sqlite/../../private"',
    'import "node:bun:ffi"',
    'import "node:bun:jsc"',
    'import "node:bun:sqlite"',
    'import "node:bun:test"',
    'import "node:bun"',
    'import "node:node:sqlite"',
    'import "node:undici"',
    'import "node:ws"',
    'import "private-dependency"',
    'import "file:///private/dependency.ts"',
    'import("node:path")',
    'const name="node:path";require(name)',
  ]) {
    expect(checkBundle(source, new Set())).toBe(false);
  }
});
