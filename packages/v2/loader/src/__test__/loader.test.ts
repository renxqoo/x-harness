import { expect, it } from "vitest";
import { mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLoader } from "../index";
import type { Loader } from "../types";
import { readLoaderOptions } from "../read-loader-options";
import { checkBundle } from "../check-bundle";
import { fingerprintShared } from "../fingerprint-shared";
import { project, value } from "./helpers";

it("real bundles share token identity and preserve current services on syntax and import errors", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));
    const token = await p.token();
    expect(value(await value(loader.use(token)).read())).toBe("one");
    const saved = value(loader.use(token));
    await p.write("two");
    value(await loader.reload());
    expect(value(await value(loader.use(token)).read())).toBe("two");
    expect((await saved.read()).ok).toBe(false);
    await writeFile(p.entry, "syntax error {");
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "build-failed" } });
    expect(value(await value(loader.use(token)).read())).toBe("two");
    const before = loader.status().imports;
    await writeFile(p.entry, 'throw new Error("private"); export default {}');
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "import-failed" } });
    expect(loader.status().imports).toBe(before + 1);
    expect(JSON.stringify(loader.status())).not.toContain("private");
    await writeFile(p.entry, "export default {name:'invalid'}");
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "invalid-plugin" } });
    await p.write("three");
    value(await loader.reload());
    expect(value(await value(loader.use(token)).read())).toBe("three");
    const closed = loader.close();
    expect(loader.close()).toBe(closed);
    value(await closed);
    expect(loader.status().state).toBe("closed");
    expect((await loader.reload()).ok).toBe(false);
  } finally {
    await p.close();
  }
});

it("unchanged bundles consume no import budget and changed shared directories require restart", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader({ ...p.options, maxImports: 2 }));
    value(await loader.reload());
    expect(loader.status().imports).toBe(1);
    await mkdir(join(p.shared, "new-directory"));
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "restart-required" } });
    expect(loader.status().state).toBe("restart-required");
    expect((await loader.reload()).ok).toBe(false);
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("failed imports spend the bounded budget and exhausted loaders keep the previous service", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader({ ...p.options, maxImports: 2 }));
    const token = await p.token();
    await writeFile(p.entry, "throw 1;export default {}");
    expect((await loader.reload()).ok).toBe(false);
    await p.write("two");
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "restart-required" } });
    expect(loader.status().imports).toBe(2);
    expect(value(await value(loader.use(token)).read())).toBe("one");
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("private dependency changes update services and concurrent reloads share bounded work", async () => {
  const p = await project();

  try {
    await writeFile(join(p.privateDir, "value.ts"), 'export const text="dependency-one"');
    await writeFile(
      p.entry,
      `import{token}from"contracts";import{text}from"./value";export default{name:"example",provides:{token},setup(ctx){return ctx.register(token,{async read(){return{ok:true,value:text}}})}}`,
    );
    const loader = value(await createLoader(p.options));
    const token = await p.token();
    expect(value(await value(loader.use(token)).read())).toBe("dependency-one");
    await writeFile(join(p.privateDir, "value.ts"), 'export const text="dependency-two"');
    const first = loader.reload();
    const second = loader.reload();
    expect(first).toBe(second);
    value(await first);
    expect(loader.status().imports).toBe(2);
    expect(value(await value(loader.use(token)).read())).toBe("dependency-two");
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("computed imports and secondary output assets are rejected before publication", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));
    await writeFile(
      p.entry,
      'export default{name:"computed",setup(){const path="node:fs";return import(path)}}',
    );
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "build-failed" } });
    expect(loader.status().imports).toBe(1);
    await writeFile(join(p.privateDir, "asset.css"), "body{color:red}");
    await writeFile(p.entry, 'import "./asset.css";export default {}');
    expect((await loader.reload()).ok).toBe(false);
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("top-level await timeout requires restart and close during import prevents late publication", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader({ ...p.options, importTimeoutMs: 500 }));
    await writeFile(p.entry, "await new Promise(()=>{});export default {}");
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "restart-required" } });
    expect(loader.status().state).toBe("restart-required");
    value(await loader.close());
    await p.write("one");
    const other = value(await createLoader(p.options));
    await writeFile(
      p.entry,
      'await Bun.sleep(20);export default{name:"late",setup(){return{ok:true,value:undefined}}}',
    );
    const reload = other.reload();
    await Bun.sleep(5);
    value(await other.close());
    expect((await reload).ok).toBe(false);
    expect(other.snapshot().plugins).toEqual([]);
  } finally {
    await p.close();
  }
});

it("bundle syntax validation rejects unresolved imports but permits strings and regex containing import text", () => {
  expect(
    checkBundle(
      'import "allowed";export default "import(x)";const re=/import\\(x\\)/',
      new Set(["allowed"]),
    ),
  ).toBe(true);

  for (const source of [
    'import "other"',
    'export{a}from"other"',
    'export*from"other"',
    "import(variable)",
    "const p=process.argv[2];require(p)",
    "import.meta.require(p)",
    "const __require=import.meta.require;__require(p)",
    "const native=import.meta.require;native(p)",
    "const {require:read}=import.meta;read(p)",
    'const key="require";import.meta[key](p)',
    'Reflect.get(import.meta,"require")(p)',
    "const a=`${import(value)}`",
    "not valid {",
  ])
    expect(checkBundle(source, new Set())).toBe(false);
});

it("malformed options and shared boundaries are rejected", async () => {
  const p = await project();

  try {
    for (const options of [
      null,
      {},
      { ...p.options, extra: true },
      { entries: [] },
      { entries: ["relative.ts"] },
      { entries: [join(p.privateDir, "missing.ts")] },
      { entries: [p.entry, p.entry] },
      { ...p.options, maxImports: 65 },
      { ...p.options, debounceMs: -1 },
      { ...p.options, importTimeoutMs: 0 },
      { ...p.options, watch: "yes" },
      { ...p.options, shared: { bad: { path: p.entry, directory: p.shared } } },
      { ...p.options, shared: { "@x-harness/core": { path: p.contract, directory: p.shared } } },
    ]) {
      expect((await createLoader(options as Parameters<typeof createLoader>[0])).ok).toBe(false);
    }

    const hostile = Object.defineProperty([], "0", {
      get() {
        throw new Error("getter");
      },
    });
    hostile.length = 1;
    expect((await readLoaderOptions({ entries: hostile })).ok).toBe(false);
    await symlink(p.entry, join(p.shared, "link"));
    expect((await createLoader(p.options)).ok).toBe(false);
  } finally {
    await p.close();
  }
});

it("shared snapshots enforce file size and total entry bounds", async () => {
  const p = await project();

  try {
    await writeFile(join(p.shared, "large"), new Uint8Array(1048577));
    await expect(
      fingerprintShared(new Map([["contracts", { path: p.contract, directory: p.shared }]])),
    ).rejects.toThrow("Shared directory limit");
  } finally {
    await p.close();
  }
});

it("real filesystem watching coalesces changes and stops after close", async () => {
  const p = await project();
  let loader: Loader | undefined;

  try {
    loader = value(await createLoader({ ...p.options, watch: true, debounceMs: 5 }));
    const token = await p.token();

    for (let i = 0; i < 3; i += 1) await p.write(`watch-${i}`);

    for (let i = 0; i < 100 && value(await value(loader.use(token)).read()) !== "watch-2"; i += 1)
      await Bun.sleep(5);

    expect(value(await value(loader.use(token)).read())).toBe("watch-2");
    expect(loader.status().imports).toBeLessThanOrEqual(4);
    value(await loader.close());
    const count = loader.status().imports;
    await p.write("after-close");
    await Bun.sleep(20);
    expect(loader.status().imports).toBe(count);
  } finally {
    await loader?.close();
    await p.close();
  }
});

it("computed require cannot load unbundled private modules", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));
    await writeFile(
      p.entry,
      `const path=${JSON.stringify(p.contract)}; const dependency=require(path); export default{name:"computed",setup(){return{ok:true,value:dependency}}}`,
    );
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "build-failed" } });
    expect(loader.status().imports).toBe(1);
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("watch recovers when a newly discovered dependency directory is fixed after a failed build", async () => {
  const p = await project();
  let loader: Loader | undefined;

  try {
    loader = value(await createLoader({ ...p.options, watch: true, debounceMs: 5 }));
    const token = await p.token();
    const nested = join(p.privateDir, "new");
    await mkdir(nested);
    const dependency = join(nested, "value.ts");
    await writeFile(dependency, "syntax error {");
    await writeFile(
      p.entry,
      'import{token}from"contracts";import{text}from"./new/value";export default{name:"example",provides:{token},setup(ctx){return ctx.register(token,{async read(){return{ok:true,value:text}}})}}',
    );
    expect((await loader.reload()).ok).toBe(false);
    expect(value(await value(loader.use(token)).read())).toBe("one");
    await writeFile(dependency, 'export const text="repaired"');
    let received = "";

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const handle = loader.use(token);

      if (handle.ok) {
        const read = await handle.value.read();

        if (read.ok) received = read.value;
      }

      if (received === "repaired") break;

      await Bun.sleep(5);
    }

    expect(received).toBe("repaired");
    value(await loader.close());
  } finally {
    await loader?.close();
    await p.close();
  }
});

it("removing an obsolete dependency directory does not permanently poison the watch set", async () => {
  const p = await project();
  let loader: Loader | undefined;

  try {
    const old = join(p.privateDir, "old");
    const next = join(p.privateDir, "next");
    await mkdir(old);
    await mkdir(next);
    await writeFile(join(old, "value.ts"), 'export const text="old"');
    await writeFile(join(next, "value.ts"), 'export const text="next"');

    const source = (folder: string) =>
      `import{token}from"contracts";import{text}from"./${folder}/value";export default{name:"example",provides:{token},setup(ctx){return ctx.register(token,{async read(){return{ok:true,value:text}}})}}`;

    await writeFile(p.entry, source("old"));
    loader = value(await createLoader({ ...p.options, watch: true, debounceMs: 5 }));
    const token = await p.token();
    await rm(old, { recursive: true });
    await writeFile(p.entry, source("next"));
    const updated = await loader.reload();
    expect(updated.ok).toBe(true);
    value(updated);
    expect(value(await value(loader.use(token)).read())).toBe("next");
    value(await loader.reload());
    expect(loader.status().error).toBeUndefined();
    value(await loader.close());
  } finally {
    await loader?.close();
    await p.close();
  }
});

it("retrying replacement after actual drain reuses the prepared module without spending another import", async () => {
  const p = await project();

  try {
    await writeFile(
      p.contract,
      (await readFile(p.contract, "utf8")) +
        ";export let finish;export const gate=new Promise(resolve=>{finish=resolve});",
    );
    await writeFile(
      p.entry,
      'import{token,gate}from"contracts";export default{name:"example",provides:{token},setup(ctx){return ctx.register(token,{async read(){await gate;return{ok:true,value:"old"}}})}}',
    );
    const loader = value(
      await createLoader({
        ...p.options,
        application: { host: { limits: { closeTimeoutMs: 20 } } },
      }),
    );
    const token = await p.token();
    const waiting = value(loader.use(token)).read();
    await Bun.sleep(1);
    await p.write("new");
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "close-incomplete" } });
    expect(loader.status().imports).toBe(2);
    expect((await waiting).ok).toBe(false);
    expect((await loader.reload()).ok).toBe(false);
    expect(loader.status().imports).toBe(2);
    const contract = (await import(pathToFileURL(p.contract).href)) as { finish(): void };
    contract.finish();

    for (let iteration = 0; iteration < 100 && loader.inspect().activeCalls; iteration += 1)
      await Bun.sleep(1);

    value(await loader.reload());
    expect(value(await value(loader.use(token)).read())).toBe("new");
    expect(loader.status().imports).toBe(2);
    value(await loader.close());
  } finally {
    await p.close();
  }
});

it("initial activation that cannot drain returns restart-required and closes late resources exactly once", async () => {
  const p = await project();

  try {
    await writeFile(
      p.contract,
      (await readFile(p.contract, "utf8")) +
        ";export let finish;export let closes=0;export function closed(){closes+=1}export const gate=new Promise(resolve=>{finish=resolve});",
    );
    const contract = (await import(pathToFileURL(p.contract).href)) as {
      finish(value: number): void;
      closes: number;
    };
    await writeFile(
      p.entry,
      'import{gate,closed}from"contracts";export default{name:"blocked",setup(ctx){return ctx.resource({open(){return gate.then(value=>({ok:true,value}))},close(){closed();return{ok:true,value:undefined}}})}}',
    );
    const result = await createLoader({
      ...p.options,
      application: { host: { limits: { activationTimeoutMs: 10, closeTimeoutMs: 10 } } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "restart-required" } });
    contract.finish(1);

    for (let iteration = 0; iteration < 100 && contract.closes === 0; iteration += 1)
      await Bun.sleep(1);

    expect(contract.closes).toBe(1);
  } finally {
    await p.close();
  }
});

it("multi-entry build failures preserve each prepared definition without spending the same import twice", async () => {
  const p = await project();

  try {
    const second = join(p.privateDir, "aux.ts");
    await writeFile(second, 'export default{name:"aux",setup(){return{ok:true,value:0}}}');
    const loader = value(
      await createLoader({ ...p.options, entries: [p.entry, second], maxImports: 4 }),
    );
    const token = await p.token();
    expect(loader.status().imports).toBe(2);
    await p.write("two");
    await writeFile(second, "syntax error {");
    expect((await loader.reload()).ok).toBe(false);
    expect(loader.status().imports).toBe(3);
    expect(value(await value(loader.use(token)).read())).toBe("one");
    expect((await loader.reload()).ok).toBe(false);
    expect(loader.status().imports).toBe(3);
    await writeFile(second, 'export default{name:"aux",setup(){return{ok:true,value:1}}}');
    value(await loader.reload());
    expect(loader.status().imports).toBe(4);
    expect(value(await value(loader.use(token)).read())).toBe("two");
    value(await loader.reload());
    expect(loader.status().imports).toBe(4);
    value(await loader.close());
  } finally {
    await p.close();
  }
});
