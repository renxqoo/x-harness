import { expect, it } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createLoader } from "../index";
import { project, value } from "./helpers";

it("multi-entry failures identify a bounded entry index and phase without exposing source paths or exception messages", async () => {
  const p = await project();
  const second = join(p.privateDir, "contains-private-credential.ts");

  try {
    await writeFile(
      second,
      'export default{name:"second",setup(){return{ok:true,value:undefined}}}',
    );
    const loader = value(await createLoader({ ...p.options, entries: [p.entry, second] }));

    try {
      for (const [source, code, phase] of [
        ["syntax error { secret-credential", "build-failed", "build"],
        ['throw new Error("secret-credential");export default {}', "import-failed", "import"],
        ['export default {name:"secret-credential"}', "invalid-plugin", "validate"],
      ]) {
        await writeFile(second, source!);
        const failed = await loader.reload();
        expect(failed).toMatchObject({
          ok: false,
          error: { source: "loader", code, entryIndex: 1, phase },
        });
        expect(loader.status().error).toMatchObject({ code, entryIndex: 1, phase });
        expect(JSON.stringify([failed, loader.status()])).not.toContain("secret-credential");
        expect(JSON.stringify(failed)).not.toContain(p.root);
      }

      await writeFile(
        second,
        'export default{name:"second",setup(){return{ok:true,value:undefined}}}',
      );
      value(await loader.reload());
      expect(loader.status().error).toBeUndefined();
    } finally {
      value(await loader.close());
    }
  } finally {
    await p.close();
  }
});
