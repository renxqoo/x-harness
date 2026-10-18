import { expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loaderFault } from "../loader-fault";
import { createLoader } from "../index";
import { project, value } from "./helpers";

const unavailable = vi.hoisted(() => new Set<string>());

vi.mock("../open-directory-watch", async (original) => {
  const native = await original<typeof import("../open-directory-watch")>();
  return { openDirectoryWatch: (target: Parameters<typeof native.openDirectoryWatch>[0], callbacks: Parameters<typeof native.openDirectoryWatch>[1]) => unavailable.has(target.path) ? loaderFault("watch-failed") : native.openDirectoryWatch(target, { changed() {}, failed: () => callbacks.failed() }) };
});

it("a failed real build recovers and preserves service when every native change notification is dropped", async () => {
  const p = await project(); const created = await createLoader({ ...p.options, watch: true, debounceMs: 5 });
  try {
    const loader = value(created), token = await p.token();
    await writeFile(p.entry, "syntax error {"); expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "build-failed" } });
    await Bun.sleep(350); expect(value(await value(loader.use(token)).read())).toBe("one"); expect(loader.status().imports).toBe(1);
    await p.write("recovered"); let text = "";
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const handle = loader.use(token); if (handle.ok) { const result = await handle.value.read(); if (result.ok) text = result.value; }
      if (text === "recovered") break; await Bun.sleep(5);
    }
    expect(text).toBe("recovered"); expect(loader.status().imports).toBe(2); expect(loader.status().error).toBeUndefined();
    await writeFile(p.entry, "syntax error {"); expect((await loader.reload()).ok).toBe(false); value(await loader.close());
    await p.write("after-close"); await Bun.sleep(150); expect(loader.status().imports).toBe(2); expect(loader.snapshot().plugins).toEqual([]);
  } finally { if (created.ok) await created.value.close(); await p.close(); }
});

it("temporary watch registration failure recovers without losing the existing service or receiving another event", async () => {
  const p = await project(); const created = await createLoader({ ...p.options, watch: true, debounceMs: 5 });
  try {
    const loader = value(created), token = await p.token(); const nested = join(p.privateDir, "new");
    await mkdir(nested); await writeFile(join(nested, "value.ts"), 'export const text="reattached"'); unavailable.add(nested);
    await writeFile(p.entry, 'import{token}from"contracts";import{text}from"./new/value";export default{name:"example",provides:{token},setup(ctx){return ctx.register(token,{async read(){return{ok:true,value:text}}})}}');
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "watch-failed" } });
    await Bun.sleep(350); expect(value(await value(loader.use(token)).read())).toBe("one"); expect(loader.status().imports).toBe(1);
    unavailable.delete(nested); let text = "";
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const handle = loader.use(token); if (handle.ok) { const result = await handle.value.read(); if (result.ok) text = result.value; }
      if (text === "reattached") break; await Bun.sleep(5);
    }
    expect(text).toBe("reattached"); expect(loader.status().imports).toBe(2); expect(loader.status().error).toBeUndefined();
  } finally { unavailable.clear(); if (created.ok) await created.value.close(); await p.close(); }
});

it("new dependency watch revalidation does not import a throwing module twice", async () => {
  const p = await project(); const created = await createLoader({ ...p.options, watch: true, debounceMs: 5 });
  try {
    const loader = value(created), token = await p.token(); value(await loader.reload()); const nested = join(p.privateDir, "new");
    await mkdir(nested); await writeFile(join(nested, "value.ts"), 'export const text="new"');
    await writeFile(p.entry, 'import{text}from"./new/value";throw new Error(text);export default{}');
    expect(await loader.reload()).toMatchObject({ ok: false, error: { code: "import-failed" } }); expect(loader.status().imports).toBe(2);
    await Bun.sleep(250); expect(loader.status().imports).toBe(2); expect(value(await value(loader.use(token)).read())).toBe("one");
  } finally { if (created.ok) await created.value.close(); await p.close(); }
});
