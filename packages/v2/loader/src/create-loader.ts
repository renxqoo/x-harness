import { normalizeWatchDirectories } from "./normalize-watch-directories";
import { dirname } from "node:path";
import { createApplication } from "../../application/src/index";
import type { ApplicationSnapshot } from "../../application/src/index";
import type { CloseReport, Plugin, Result } from "../../core/src/index";
import { readLoaderOptions } from "./read-loader-options";
import { fingerprintShared } from "./fingerprint-shared";
import { buildModule } from "./build-module";
import { importModule } from "./import-module";
import { loaderFault } from "./loader-fault";
import { watchDirectories } from "./watch-directories";
import type { Loader, LoaderFault, LoaderOptions } from "./types";

export async function createLoader(options: LoaderOptions): Promise<Result<Loader, LoaderFault>> {
  const parsed = await readLoaderOptions(options); if (!parsed.ok) return parsed; const config = parsed.value;
  let fingerprint: string; try { fingerprint = await fingerprintShared(config.shared); } catch { return loaderFault("invalid-input"); }
  const created = createApplication(config.application); if (!created.ok) return created; const app = created.value;
  let closed = false; let restart = false; let count = 0; let error: LoaderFault | undefined; let dirty = false;
  let running: Promise<Result<ApplicationSnapshot, LoaderFault>> | undefined; let closing: Promise<Result<CloseReport>> | undefined;
  let clearWatch: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const directories = new Set([...config.entries.map(dirname), ...[...config.shared.values()].map((item) => item.directory)]);
  const recursive = new Set(directories); let watched = "";
  const cache = new Map<string, { hash: string; plugin: Plugin }>();
  const fail = (code: LoaderFault["code"]) => { const fault = loaderFault(code); error = fault.error; if (code === "restart-required") restart = true; return fault; };
  const schedule = () => { if (closed || restart) return; dirty = true; if (running || timer) return; timer = setTimeout(() => { timer = undefined; void reload(); }, config.debounceMs); };
  const syncWatch = async (): Promise<boolean> => {
    if (!config.watch || closed) return true;
    let snapshot: Awaited<ReturnType<typeof normalizeWatchDirectories>>;
    try { snapshot = await normalizeWatchDirectories(directories, recursive); } catch { fail("watch-failed"); return false; }
    if (closed) return true;
    const paths = snapshot.paths; const next = snapshot.signature; if (next === watched) return true;
    const watching = watchDirectories(paths, recursive, { changed: schedule, failed: () => { fail("watch-failed"); clearWatch?.(); clearWatch = undefined; watched = ""; schedule(); } });
    if (!watching.ok) { fail("watch-failed"); return false; }
    clearWatch?.(); clearWatch = watching.value; watched = next; dirty = true; return true;
  };
  const apply = async (): Promise<Result<ApplicationSnapshot, LoaderFault>> => {
    try { if (await fingerprintShared(config.shared) !== fingerprint) return fail("restart-required"); } catch { return fail("restart-required"); }
    const next = new Map<string, { hash: string; plugin: Plugin }>();
    for (const entry of config.entries) {
      let watchOverflow = false;
      const built = await buildModule(entry, config, (directory) => { if (!directories.has(directory) && directories.size >= 512) { watchOverflow = true; throw new Error("Watch directory limit"); } directories.add(directory); });
      if (watchOverflow) return fail("restart-required");
      if (!await syncWatch()) return fail("watch-failed"); if (!built.ok) return fail("build-failed");
      for (const directory of built.value.directories) directories.add(directory);
      const previous = cache.get(entry); if (previous?.hash === built.value.hash) { next.set(entry, previous); continue; }
      if (closed) return fail("closed"); if (count >= config.maxImports) return fail("restart-required"); count += 1;
      const loaded = await importModule(built.value.source, config.importTimeoutMs); if (closed) return fail("closed"); if (!loaded.ok) return fail(loaded.error.source === "loader" ? loaded.error.code : "import-failed");
      const prepared = { hash: built.value.hash, plugin: loaded.value }; cache.set(entry, prepared); next.set(entry, prepared);
    }
    try { if (await fingerprintShared(config.shared) !== fingerprint) return fail("restart-required"); } catch { return fail("restart-required"); }
    if (closed) return fail("closed");
    const result = await app.setPlugins([...next.values()].map((entry) => entry.plugin));
    if (closed) return fail("closed");
    if (result.ok) error = undefined;
    return result;
  };
  const reload = (): Promise<Result<ApplicationSnapshot, LoaderFault>> => {
    if (closed) return Promise.resolve(fail("closed")); if (restart) return Promise.resolve(fail("restart-required"));
    if (timer) { clearTimeout(timer); timer = undefined; }
    dirty = true; if (running) return running;
    running = (async () => { let result: Result<ApplicationSnapshot, LoaderFault>;
      do { dirty = false; result = await apply(); } while (dirty && !closed && !restart);
      return result;
    })().finally(() => { running = undefined; }); return running;
  };
  const close = () => {
    if (!closing) { closed = true; dirty = false; if (timer) clearTimeout(timer); timer = undefined; clearWatch?.(); clearWatch = undefined; cache.clear(); const closingApp = app.close(); closing = Promise.all([closingApp, running]).then(([result]) => result); }
    return closing;
  };
  const status = () => {
    let state: "open" | "closed" | "restart-required" = "open"; if (closed) state = "closed"; else if (restart) state = "restart-required";
    return Object.freeze({ state, imports: count, maxImports: config.maxImports, ...(error ? { error } : {}) });
  };
  if (!await syncWatch()) { await close(); return fail("watch-failed"); }
  const initial = await reload(); if (!initial.ok) { const closed = await close(); return closed.ok ? initial : fail("restart-required"); }
  if (config.watch) schedule();
  return { ok: true, value: Object.freeze({ reload, close, use: app.use, dispatch: app.dispatch, snapshot: () => app.snapshot(), inspect: () => app.inspect(),
    status,
  } satisfies Loader) };
}
