import { describe } from "vitest";
import { createFakeEnv } from "./fake-env.ts";
import { writeFaceSuite } from "./conformance-write.ts";

describe("write-face conformance（内存 fake）", writeFaceSuite((root) => createFakeEnv(root)));
