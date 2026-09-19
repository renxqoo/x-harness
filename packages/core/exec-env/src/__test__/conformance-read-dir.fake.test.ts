// readDir 面 fake 腿：file/dir kind + 错误三态（symlink 不水化——local 腿权威）。

import { describe } from "vitest";
import { createFakeEnv } from "./fake-env.ts";
import { readDirSuite } from "./conformance-read-dir.ts";

describe("readDir conformance（内存 fake）", readDirSuite((root) => createFakeEnv(root), { symlink: false }));
