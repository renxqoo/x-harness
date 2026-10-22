import { expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintSdk } from "../fingerprint-sdk";
import { fingerprintShared } from "../fingerprint-shared";
import { createSdkPins } from "../create-sdk-pins";
import { pinSdk } from "../pin-sdk";
import { loaderFault } from "../loader-fault";

it("SDK fingerprints include dependency content and empty directories while excluding unit tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-fingerprint-"));
  try {
    const a = join(directory, "a.ts"); const b = join(directory, "b.ts"); await writeFile(a, "a"); await writeFile(b, "b");
    const first = await fingerprintSdk([directory]); expect(await fingerprintSdk([b, a, directory])).toBe(first);
    await mkdir(join(directory, "__test__")); await writeFile(join(directory, "__test__", "test.ts"), "test"); expect(await fingerprintSdk([directory])).toBe(first);
    await writeFile(a, "changed"); const second = await fingerprintSdk([directory]); expect(second).not.toBe(first);
    await mkdir(join(directory, "empty")); expect(await fingerprintSdk([directory])).not.toBe(second);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("SDK fingerprint budgets reject symbolic links and oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-fingerprint-bounds-"));
  try {
    const file = join(directory, "file"); await writeFile(file, "data"); await symlink(file, join(directory, "link"));
    await expect(fingerprintSdk([directory])).rejects.toThrow("Unsupported SDK link"); await rm(join(directory, "link"));
    await writeFile(file, new Uint8Array(1048577)); await expect(fingerprintSdk([directory])).rejects.toThrow("SDK source limit");
    await rm(file); for (let index = 0; index < 17; index += 1) await writeFile(join(directory, "large" + index), new Uint8Array(1048576));
    await expect(fingerprintSdk([directory])).rejects.toThrow("SDK source limit");
    for (let index = 0; index < 17; index += 1) await rm(join(directory, "large" + index));
    for (let index = 0; index < 2049; index += 1) await writeFile(join(directory, String(index)), "");
    await expect(fingerprintSdk([directory])).rejects.toThrow("SDK source limit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("SDK pins keep one immutable process generation and bound the number of SDK roots", () => {
  const pins = createSdkPins(); expect(pins.pin("sdk", "first")).toBe(true); expect(pins.pin("sdk", "first")).toBe(true); expect(pins.pin("sdk", "changed")).toBe(false);
  for (let index = 1; index < 64; index += 1) expect(pins.pin("sdk" + index, "first")).toBe(true);
  expect(pins.pin("overflow", "first")).toBe(false); expect(pins.pin("sdk", "first")).toBe(true);
  const root = "sdk-unit-test"; expect(pinSdk(root, "a".repeat(64))).toBe(true); expect(pinSdk(root, "a".repeat(64))).toBe(true); expect(pinSdk(root, "b".repeat(64))).toBe(false);
  for (const [name, hash] of [["", "a".repeat(64)], ["x".repeat(4097), "a".repeat(64)], [root, "invalid"]]) expect(pinSdk(name!, hash!)).toBe(false);
});

it("Loader fault metadata accepts only bounded entry indexes and known phases", () => {
  expect(loaderFault("build-failed", { phase: "build", entryIndex: 127 }).error).toEqual({ source: "loader", code: "build-failed", message: "build-failed", phase: "build", entryIndex: 127 });
  for (const entryIndex of [-1, 128, Infinity, 1.5]) expect(loaderFault("build-failed", { entryIndex }).error.entryIndex).toBeUndefined();
  expect(loaderFault("build-failed", { phase: "private-source" as never }).error.phase).toBeUndefined(); expect(Object.isFrozen(loaderFault("closed").error)).toBe(true);
});

it("invalid or throwing process SDK ports fail closed without propagating callbacks", async () => {
  const entry = new URL("../pin-sdk.ts", import.meta.url).pathname;
  for (const descriptor of ["{value:null}", "{get(){throw 1}}", "{value:{pin(){throw 1}}}", "{value:{get pin(){throw 1}}}"]) {
    const source = `import{pinSdk}from ${JSON.stringify(entry)};Object.defineProperty(globalThis,Symbol.for("@x-harness/plugin-loader/sdk-fingerprints"),${descriptor});process.stdout.write(String(pinSdk("sdk","a".repeat(64))));`;
    const child = Bun.spawn(["bun", "--eval", source], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "false", stderr: "" });
  }
});

it("stable source fingerprints cannot alias file names with contents or empty directories with files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-fingerprint-frame-"));
  const shared = new Map([["contract", { path: join(directory, "contract.ts"), directory }]]);
  try {
    const a = join(directory, "a"); const ab = join(directory, "ab"); await writeFile(a, "b");
    const before = await Promise.all([fingerprintSdk([directory]), fingerprintShared(shared)]);
    await rename(a, ab); await writeFile(ab, ""); const renamed = await Promise.all([fingerprintSdk([directory]), fingerprintShared(shared)]);
    expect(renamed[0]).not.toBe(before[0]); expect(renamed[1]).not.toBe(before[1]);
    await rm(ab); await mkdir(ab); const changedKind = await Promise.all([fingerprintSdk([directory]), fingerprintShared(shared)]);
    expect(changedKind[0]).not.toBe(renamed[0]); expect(changedKind[1]).not.toBe(renamed[1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
