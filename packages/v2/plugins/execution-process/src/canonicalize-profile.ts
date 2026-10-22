import { realpath, stat } from "node:fs/promises";
import { readData } from "../../../core/src/validation";
import type { ProcessProfile, CanonicalProfile } from "./types";
import { fail } from "./fail";

export async function canonicalizeProfile(profile: ProcessProfile) {
  try {
    const paths = await Promise.all(
      [profile.cwd, ...(profile.readRoots ?? []), ...(profile.writeRoots ?? [])].map(
        async (path) => {
          if (!path.startsWith("/") || path.includes("\0")) throw new Error("path");

          const value = await realpath(path);

          if (!(await stat(value)).isDirectory()) throw new Error("path");

          return value;
        },
      ),
    );
    const cwd = paths[0]!,
      readCount = profile.readRoots?.length ?? 0;
    const writes = [...new Set(paths.slice(1 + readCount))];

    if (
      writes.some((path) =>
        ["/", "/usr", "/bin", "/sbin", "/System", "/Library", "/dev", "/private/etc"].some(
          (root) => path === root || path.startsWith(root + "/"),
        ),
      )
    )
      return fail("access-denied");

    const env = readData(profile.env ?? {});

    if (!env.ok) return fail("invalid-input");

    const value: CanonicalProfile = Object.freeze({
      cwd,
      readRoots: Object.freeze([...new Set([cwd, ...paths.slice(1, 1 + readCount), ...writes])]),
      writeRoots: Object.freeze(writes),
      env: Object.freeze({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: cwd,
        LANG: "C.UTF-8",
        ...(env.value as Record<string, string>),
      }),
      allowEnv: Object.freeze([...(profile.allowEnv ?? [])]),
      allowedDomains: Object.freeze([...(profile.allowedDomains ?? [])]),
    });

    if (new TextEncoder().encode(JSON.stringify(value.env)).length > 16384)
      return fail("invalid-input");

    return { ok: true as const, value };
  } catch {
    return fail("access-denied");
  }
}
