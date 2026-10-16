import { afterEach, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeProject } from "../write-project";

vi.mock("node:fs/promises", async (original) => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open) }; });
afterEach(() => { vi.mocked(open).mockReset(); });

it("write failure preserves an incomplete directory and never deletes visible files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-write-")); const directory = join(root, "target");
  try {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); vi.mocked(open).mockImplementation(actual.open);
    const result = await writeProject(directory, new Map([["first", "owned"], ["nested/fail", "fail"]])); expect(result.ok).toBe(false);
    expect((await lstat(directory)).isDirectory()).toBe(true); expect(await readFile(join(directory, "first"), "utf8")).toBe("owned");
    await expect(lstat(join(directory, ".ready"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("write failure preserves competitor files and replaced file identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-identity-")); const directory = join(root, "target");
  try {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(actual.open).mockImplementationOnce(async () => {
      await unlink(join(directory, "first")); await writeFile(join(directory, "first"), "competitor"); await writeFile(join(directory, "extra"), "keep"); throw new Error("injected write failure");
    });
    expect((await writeProject(directory, new Map([["first", "owned"], ["second", "fail"]]))).ok).toBe(false);
    expect(await readFile(join(directory, "first"), "utf8")).toBe("competitor"); expect(await readFile(join(directory, "extra"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("write failure never deletes a replaced target directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-directory-")); const directory = join(root, "target");
  try {
    vi.mocked(open).mockImplementationOnce(async () => { await rename(directory, directory + "-moved"); await mkdir(directory); await writeFile(join(directory, "user-file"), "keep"); throw new Error("injected replacement"); });
    expect((await writeProject(directory, new Map([["first", "owned"]]))).ok).toBe(false); expect(await readFile(join(directory, "user-file"), "utf8")).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("publication refusal does not touch an existing target and missing parents fail safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-existing-"));
  try { expect((await writeProject(root, new Map())).ok).toBe(false); expect((await writeProject(join(root, "missing", "target"), new Map())).ok).toBe(false); }
  finally { await rm(root, { recursive: true, force: true }); }
});
