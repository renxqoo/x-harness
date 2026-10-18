import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectoryWatch } from "../create-directory-watch";
import { openDirectoryWatch } from "../open-directory-watch";
import { createRefresh } from "../create-refresh";
import type { WatchCallbacks } from "../watch-types";
import { value } from "./helpers";

const root = await mkdtemp(join(tmpdir(), "loader-watch-gc-"));
async function capture() {
  const registryMarker = { bytes: new Uint8Array(4096) }, nativeMarker = { bytes: new Uint8Array(4096) }, refreshMarker = { bytes: new Uint8Array(4096) };
  const late: WatchCallbacks[] = [];
  const registry = createDirectoryWatch({ changed() { void registryMarker.bytes; }, failed() { void registryMarker.bytes; } }, (_target, callbacks) => { late.push(callbacks); return { ok: true, value() {} }; });
  value(registry.sync([{ path: root, identity: root, recursive: false }])); registry.close();
  const closeNative = value(openDirectoryWatch({ path: root, identity: root, recursive: false }, { changed() { void nativeMarker.bytes; }, failed() { void nativeMarker.bytes; } })); closeNative();
  const refresh = createRefresh({ watch: true, debounceMs: 0, blocked: () => undefined, async run() { void refreshMarker.bytes; return { ok: false, error: { source: "loader", code: "build-failed", message: "failed" } }; } });
  await refresh.reload(); await refresh.close();
  return { weak: [new WeakRef(registryMarker), new WeakRef(nativeMarker), new WeakRef(refreshMarker)], retained: { registry, closeNative, refresh, late } };
}
try {
  const captured = await capture(); let collected = false;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(5); Bun.gc(true); collected = captured.weak.every((weak) => weak.deref() === undefined); if (collected) break;
  }
  assert.equal(collected, true); captured.retained.late[0]!.changed(); captured.retained.late[0]!.failed(); captured.retained.registry.close(); captured.retained.closeNative(); await captured.retained.refresh.close();
  process.stdout.write("passed\n");
} finally { await rm(root, { recursive: true, force: true }); }
