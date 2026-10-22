import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildModule } from "../build-module";
import { createLoader } from "../index";
import { readLoaderOptions } from "../read-loader-options";
import { project, value } from "./helpers";

it("missing nested imports discover their nearest existing directory and recover after creation", async () => {
  const p = await project();

  try {
    const config = value(await readLoaderOptions(p.options));
    const discovered: string[] = [];
    await writeFile(p.entry, 'import {text} from "./missing/deep/value";export default text');
    expect(
      await buildModule(p.entry, config, (directory) => discovered.push(directory)),
    ).toMatchObject({
      ok: false,
      error: { code: "build-failed" },
    });
    expect(discovered).toContain(p.privateDir);
    const nested = join(p.privateDir, "missing/deep");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "value.ts"), 'export const text="recovered"');
    const rebuilt = value(await buildModule(p.entry, config));
    expect(rebuilt.directories).toContain(nested);
    expect(rebuilt.source).toContain("recovered");
  } finally {
    await p.close();
  }
});

it("shared relative imports remain external while private dependencies are bundled", async () => {
  const p = await project();

  try {
    await writeFile(join(p.shared, "detail.ts"), 'export const detail="shared-detail"');
    await writeFile(join(p.privateDir, "detail.ts"), 'export const detail="private-detail"');
    await writeFile(
      p.entry,
      'import{detail as shared}from"../shared/detail";import{detail as privateValue}from"./detail";export default{shared,privateValue}',
    );
    const config = value(await readLoaderOptions(p.options));
    const built = value(await buildModule(p.entry, config));
    expect(built.source).toContain(pathToFileURL(join(p.shared, "detail.ts")).href);
    expect(built.source).toContain("private-detail");
    expect(built.source).not.toContain("shared-detail");
  } finally {
    await p.close();
  }
});

it("oversized bundles are rejected without replacing the active plugin or spending an import", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));

    try {
      const token = await p.token();
      await writeFile(p.entry, `export default ${JSON.stringify("x".repeat(1048577))}`);
      expect(await loader.reload()).toMatchObject({
        ok: false,
        error: { code: "build-failed", phase: "build", entryIndex: 0 },
      });
      expect(loader.status().imports).toBe(1);
      expect(value(await value(loader.use(token)).read())).toBe("one");
    } finally {
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});

it("dependency directory overflow requires restart and preserves the previously active service", async () => {
  const p = await project();

  try {
    const loader = value(await createLoader(p.options));

    try {
      const imports = await Promise.all(
        Array.from({ length: 513 }, async (_, index) => {
          const directory = join(p.privateDir, `dependency-${index}`);
          await mkdir(directory);
          await writeFile(join(directory, "value.ts"), `export const value=${index}`);
          return `import{value as value${index}}from"./dependency-${index}/value";`;
        }),
      );
      await writeFile(
        p.entry,
        `${imports.join("")}export default[${imports.map((_, index) => `value${index}`).join(",")}]`,
      );
      const config = value(await readLoaderOptions(p.options));
      expect(await buildModule(p.entry, config)).toMatchObject({
        ok: false,
        error: { code: "build-failed" },
      });
      expect(await loader.reload()).toMatchObject({
        ok: false,
        error: { code: "restart-required", phase: "watch", entryIndex: 0 },
      });
      expect(loader.status().state).toBe("restart-required");
      expect(loader.status().imports).toBe(1);
      expect(value(await value(loader.use(await p.token())).read())).toBe("one");
    } finally {
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});
