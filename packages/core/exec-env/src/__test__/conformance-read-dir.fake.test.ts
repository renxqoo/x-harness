import { describe } from "vitest";
import { createFakeEnv } from "./fake-env.ts";
import { readDirSuite } from "./conformance-read-dir.ts";

describe("readDir conformance（内存 fake）", readDirSuite((root) => createFakeEnv(root), { symlink: false }));
