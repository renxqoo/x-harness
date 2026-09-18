// readDir 面 local 腿：kind 矩阵（含 symlink）+ 错误三态。

import { describe } from "vitest";
import { createLocalEnv } from "../local/env.ts";
import { readDirSuite } from "./conformance-read-dir.ts";

describe("readDir conformance（local 真盘）", readDirSuite((root) => createLocalEnv(root), { symlink: true }));
