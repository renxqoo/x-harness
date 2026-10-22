import { lstat, mkdir, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { CreateProjectResult } from "./types";
import { projectFault } from "./project-fault";

export async function writeProject(
  directory: string,
  files: ReadonlyMap<string, string>,
): Promise<CreateProjectResult> {
  let owned: Stats;

  try {
    await mkdir(directory, { mode: 0o700 });
    owned = await lstat(directory);
  } catch (error) {
    return projectFault(
      (error as { code?: string })?.code === "EEXIST" ? "target-exists" : "write-failed",
    );
  }

  const matches = (current: Stats) =>
    !current.isSymbolicLink() && owned.dev === current.dev && owned.ino === current.ino;

  try {
    for (const [name, contents] of files) {
      if (!matches(await lstat(directory))) throw new Error("Directory changed");

      const file = await open(join(directory, name), "wx", 0o600);

      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }

      if (!matches(await lstat(directory))) throw new Error("Directory changed");
    }

    return {
      ok: true,
      value: Object.freeze({ directory, files: Object.freeze([...files.keys()]) }),
    };
  } catch {
    return projectFault("write-failed", directory);
  }
}
