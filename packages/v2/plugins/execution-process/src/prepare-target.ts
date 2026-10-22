import { realpath, access, stat, constants } from "node:fs/promises";
import { join, relative } from "node:path";
import { readData, readJsonValue } from "../../../core/src/validation";
import { createExecutionTarget } from "../../execution/src/index";
import type { ExecutionResult } from "../../execution/src/index";
import type { CanonicalProfile, ProcessTarget } from "./types";
import { readIdentity } from "./read-identity";
import { fail } from "./fail";

export async function prepareTarget(
  raw: unknown,
  options: {
    backend: string;
    isolation: "none" | "seatbelt-single-process";
    systemReadRoots: readonly string[];
    profiles: ReadonlyMap<string, CanonicalProfile>;
    root: string;
  },
): Promise<ExecutionResult<ProcessTarget>> {
  const json = readJsonValue(raw);

  if (!json.ok) return fail("invalid-input");

  const d = readData(json.value);

  if (
    !d.ok ||
    Object.keys(d.value).some((k) => !["profile", "argv", "cwd", "env"].includes(k)) ||
    typeof d.value.profile !== "string" ||
    !Array.isArray(d.value.argv) ||
    !d.value.argv.length ||
    d.value.argv.length > 256 ||
    d.value.argv.some((x) => typeof x !== "string" || x.includes("\0")) ||
    !(d.value.argv[0] as string).startsWith("/") ||
    (d.value.cwd !== undefined &&
      (typeof d.value.cwd !== "string" ||
        !d.value.cwd.startsWith("/") ||
        d.value.cwd.includes("\0")))
  )
    return fail("invalid-input");

  const profile = options.profiles.get(d.value.profile);

  if (!profile) return fail("profile-not-found");

  const env = readData(d.value.env ?? {});

  if (
    !env.ok ||
    Object.entries(env.value).some(
      ([key, value]) =>
        !/^[_A-Za-z][_A-Za-z0-9]*$/.test(key) ||
        !profile.allowEnv.includes(key) ||
        typeof value !== "string" ||
        value.includes("\0"),
    ) ||
    new TextEncoder().encode(JSON.stringify(env.value)).length > 16384
  )
    return fail("access-denied");

  try {
    const cwd = await realpath((d.value.cwd as string | undefined) ?? profile.cwd);
    const rel = relative(profile.cwd, cwd);

    if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return fail("access-denied");

    const executable = await realpath(d.value.argv[0] as string);
    await access(executable, constants.X_OK);

    if (!(await stat(executable)).isFile() || !(await stat(cwd)).isDirectory())
      return fail("access-denied");

    const environment = Object.freeze({ ...profile.env, ...env.value }) as Record<string, string>;

    if (new TextEncoder().encode(JSON.stringify(environment)).length > 16384)
      return fail("invalid-input");

    const argv = Object.freeze([executable, ...(d.value.argv.slice(1) as string[])]);
    const identities = await Promise.all(
      [
        ...new Set([
          d.value.argv[0] as string,
          executable,
          cwd,
          profile.cwd,
          ...profile.readRoots,
          ...profile.writeRoots,
        ]),
      ].map(async (path) => {
        const identity = await readIdentity(path);
        return Object.freeze({ ...identity, path });
      }),
    );
    const sandbox = options.isolation === "seatbelt-single-process";
    const resources = sandbox
      ? [
          ...[...profile.readRoots, ...options.systemReadRoots].map((path) => ({
            domain: "filesystem",
            path: path.split("/").filter(Boolean),
            mode: "read" as const,
            scope: "subtree" as const,
          })),
          ...profile.writeRoots.map((path) => ({
            domain: "filesystem",
            path: path.split("/").filter(Boolean),
            mode: "write" as const,
            scope: "subtree" as const,
          })),
          {
            domain: "filesystem",
            path: executable.split("/").filter(Boolean),
            mode: "read" as const,
            scope: "exact" as const,
          },
        ]
      : [{ domain: "filesystem", path: [], mode: "write" as const, scope: "subtree" as const }];
    const target = createExecutionTarget({
      backend: options.backend,
      profile: d.value.profile,
      argv,
      cwd,
      env: environment,
      resources,
      restrictions: {
        isolation: sandbox ? "seatbelt-single-process" : "none",
        readRoots: profile.readRoots,
        systemReadRoots: options.systemReadRoots,
        writeRoots: profile.writeRoots,
        network: sandbox ? profile.allowedDomains : "unrestricted",
      },
    });

    if (!target.ok) return fail("invalid-input");

    return {
      ok: true,
      value: {
        target: target.value,
        profile,
        identities,
        scratch: join(options.root, crypto.randomUUID()),
        used: false,
      },
    };
  } catch {
    return fail("access-denied");
  }
}
