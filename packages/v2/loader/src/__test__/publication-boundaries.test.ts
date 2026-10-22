import { expect, it } from "vitest";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLoader } from "../index";
import { project, value } from "./helpers";

async function gatedProject() {
  const p = await project();
  await appendFile(
    p.contract,
    ";export let enter;export let release;export const entered=new Promise(resolve=>{enter=resolve});export const gate=new Promise(resolve=>{release=resolve});",
  );
  const contract = (await import(pathToFileURL(p.contract).href)) as {
    entered: Promise<void>;
    release(): void;
  };
  return { ...p, contract };
}

it("an unreadable shared generation is rejected before activating any plugin", async () => {
  const p = await project();

  try {
    await writeFile(join(p.shared, "oversized"), new Uint8Array(1048577));
    expect(await createLoader(p.options)).toMatchObject({
      ok: false,
      error: { code: "invalid-input", phase: "shared" },
    });
  } finally {
    await p.close();
  }
});

it("invalid application limits fail before importing an otherwise valid module", async () => {
  const p = await project();

  try {
    expect(await createLoader({ ...p.options, application: { maxPlugins: 0 } })).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  } finally {
    await p.close();
  }
});

it("shared files disappearing during import require restart without publishing the prepared plugin", async () => {
  const p = await gatedProject();

  try {
    const loader = value(await createLoader(p.options));

    try {
      const token = await p.token();
      await writeFile(
        p.entry,
        'import{enter,gate}from"contracts";enter();await gate;export default{name:"prepared",setup(){return{ok:true,value:undefined}}}',
      );
      const pending = loader.reload();
      await p.contract.entered;
      await rm(p.shared, { recursive: true });
      p.contract.release();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "restart-required", phase: "shared" },
      });
      expect(loader.status().imports).toBe(2);
      expect(loader.snapshot().plugins.map((plugin) => plugin.name)).toEqual(["example"]);
      expect(value(await value(loader.use(token)).read())).toBe("one");
    } finally {
      p.contract.release();
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});

it("closing a loader during a confirmed module import prevents late publication", async () => {
  const p = await gatedProject();

  try {
    const loader = value(await createLoader(p.options));

    try {
      await writeFile(
        p.entry,
        'import{enter,gate}from"contracts";enter();await gate;export default{name:"late-import",setup(){return{ok:true,value:undefined}}}',
      );
      const pending = loader.reload();
      await p.contract.entered;
      const closing = loader.close();
      p.contract.release();
      expect(await pending).toMatchObject({ ok: false, error: { code: "closed" } });
      value(await closing);
      expect(loader.status().state).toBe("closed");
      expect(loader.snapshot().plugins).toEqual([]);
      expect(loader.inspect().activeCalls).toBe(0);
    } finally {
      p.contract.release();
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});

it("closing a loader during asynchronous plugin activation drains it and rejects the reload", async () => {
  const p = await gatedProject();

  try {
    const loader = value(await createLoader(p.options));

    try {
      await writeFile(
        p.entry,
        'import{enter,gate}from"contracts";export default{name:"late-activation",async setup(){enter();await gate;return{ok:true,value:undefined}}}',
      );
      const pending = loader.reload();
      await p.contract.entered;
      const closing = loader.close();
      p.contract.release();
      expect(await pending).toMatchObject({ ok: false, error: { code: "closed" } });
      value(await closing);
      expect(loader.status().state).toBe("closed");
      expect(loader.snapshot().plugins).toEqual([]);
      expect(loader.inspect().activeCalls).toBe(0);
    } finally {
      p.contract.release();
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});
