import type { Result } from "../../core/src/index";
import type { LoaderFault } from "./types";
import { fingerprintSdk } from "./fingerprint-sdk";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pinSdk } from "./pin-sdk";
import { loaderFault } from "./loader-fault";

export async function readSdkGeneration(): Promise<Result<string, LoaderFault>> {
  try {
    const fingerprint = await fingerprintSdk();
    const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    return pinSdk(root, fingerprint)
      ? { ok: true, value: fingerprint }
      : loaderFault("restart-required", { phase: "sdk" });
  } catch {
    return loaderFault("restart-required", { phase: "sdk" });
  }
}
