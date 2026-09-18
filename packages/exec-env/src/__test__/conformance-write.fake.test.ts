// write 面 fake 腿：双腿套件（makeParents/is_directory/父段文件/版本换 ino 的契约隔离预演）。

import { describe } from "vitest";
import { createFakeEnv } from "./fake-env.ts";
import { writeFaceSuite } from "./conformance-write.ts";

describe("write-face conformance（内存 fake）", writeFaceSuite((root) => createFakeEnv(root)));
