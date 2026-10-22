import { normalizeWatchDirectories } from "./normalize-watch-directories";
import { dirname } from "node:path";
import { createApplication } from "../../application/src/index";
import type { ApplicationSnapshot } from "../../application/src/index";
import type { CloseReport, Plugin, Result } from "../../core/src/index";
import { readLoaderOptions } from "./read-loader-options";
import { fingerprintShared } from "./fingerprint-shared";
import { fingerprintSdk } from "./fingerprint-sdk";
import { sdkDirectories } from "./sdk-directories";
import { readSdkGeneration } from "./read-sdk-generation";
import { buildModule } from "./build-module";
import { importModule } from "./import-module";
import { loaderFault } from "./loader-fault";
import { createDirectoryWatch } from "./create-directory-watch";
import { createRefresh } from "./create-refresh";
import type { Loader, LoaderFault, LoaderOptions, LoaderPhase } from "./types";

const sdkGeneration = await readSdkGeneration();

export async function createLoader(options: LoaderOptions): Promise<Result<Loader, LoaderFault>> {
  const parsed = await readLoaderOptions(options);

  if (!parsed.ok) return parsed;

  const config = parsed.value;

  if (!sdkGeneration.ok) return sdkGeneration;

  const stableSdk = sdkGeneration.value;
  let fingerprint: string;

  try {
    fingerprint = await fingerprintShared(config.shared);
  } catch {
    return loaderFault("invalid-input", { phase: "shared" });
  }

  const created = createApplication(config.application);

  if (!created.ok) return created;

  const app = created.value;
  let closed = false;
  let restart = false;
  let count = 0;
  let error: LoaderFault | undefined;
  let closing: Promise<Result<CloseReport>> | undefined;
  const directories = new Set([
    ...sdkDirectories,
    ...config.entries.map(dirname),
    ...[...config.shared.values()].map((item) => item.directory),
  ]);
  const recursive = new Set(directories);
  const cache = new Map<string, { hash: string; plugin: Plugin }>();

  const fail = (
    code: LoaderFault["code"],
    context: { readonly phase?: LoaderPhase; readonly entryIndex?: number } = {},
  ) => {
    const fault = loaderFault(code, context);
    error = fault.error;

    if (code === "restart-required") restart = true;

    return fault;
  };

  const watching = createDirectoryWatch({
    changed() {
      refresh.changed();
    },
    failed() {
      fail("watch-failed", { phase: "watch" });
      refresh.failed();
    },
  });

  const syncWatch = async (): Promise<boolean> => {
    if (!config.watch || closed) return true;

    let snapshot: Awaited<ReturnType<typeof normalizeWatchDirectories>>;

    try {
      snapshot = await normalizeWatchDirectories(directories, recursive);
    } catch {
      fail("watch-failed", { phase: "watch" });
      return false;
    }

    if (closed) return true;

    const synced = watching.sync(snapshot);

    if (!synced.ok) {
      fail("watch-failed", { phase: "watch" });
      return false;
    }

    if (synced.value) refresh.revalidate();

    return true;
  };

  const verifyStable = async (): Promise<Result<void, LoaderFault>> => {
    try {
      if ((await fingerprintSdk()) !== stableSdk) return fail("restart-required", { phase: "sdk" });
    } catch {
      return fail("restart-required", { phase: "sdk" });
    }

    try {
      if ((await fingerprintShared(config.shared)) !== fingerprint)
        return fail("restart-required", { phase: "shared" });
    } catch {
      return fail("restart-required", { phase: "shared" });
    }

    return { ok: true, value: undefined };
  };

  const apply = async (): Promise<Result<ApplicationSnapshot, LoaderFault>> => {
    const before = await verifyStable();

    if (!before.ok) return before;

    const next = new Map<string, { hash: string; plugin: Plugin }>();

    for (const [entryIndex, entry] of config.entries.entries()) {
      let watchOverflow = false;
      const built = await buildModule(entry, config, (directory) => {
        if (!directories.has(directory) && directories.size >= 512) {
          watchOverflow = true;
          throw new Error("Watch directory limit");
        }

        directories.add(directory);
      });

      if (watchOverflow) return fail("restart-required", { phase: "watch", entryIndex });

      if (!(await syncWatch())) return fail("watch-failed", { phase: "watch" });

      if (!built.ok) return fail("build-failed", { phase: "build", entryIndex });

      for (const directory of built.value.directories) directories.add(directory);

      const previous = cache.get(entry);

      if (previous?.hash === built.value.hash) {
        next.set(entry, previous);
        continue;
      }

      if (closed) return fail("closed");

      if (count >= config.maxImports)
        return fail("restart-required", { phase: "import", entryIndex });

      count += 1;
      const loaded = await importModule(built.value.source, config.importTimeoutMs);

      if (closed) return fail("closed");

      if (!loaded.ok)
        return fail(loaded.error.source === "loader" ? loaded.error.code : "import-failed", {
          phase: loaded.error.source === "loader" ? (loaded.error.phase ?? "import") : "import",
          entryIndex,
        });

      const prepared = { hash: built.value.hash, plugin: loaded.value };
      cache.set(entry, prepared);
      next.set(entry, prepared);
    }

    const after = await verifyStable();

    if (!after.ok) return after;

    if (closed) return fail("closed");

    const result = await app.setPlugins([...next.values()].map((entry) => entry.plugin));

    if (closed) return fail("closed");

    if (result.ok) error = undefined;

    return result;
  };

  const refresh = createRefresh({
    async run() {
      try {
        return await apply();
      } catch {
        return fail("restart-required");
      }
    },
    blocked() {
      if (closed) return "closed";

      if (restart) return "restart-required";

      return undefined;
    },
    debounceMs: config.debounceMs,
    watch: config.watch,
  });

  const reload = () => {
    if (closed) return Promise.resolve(fail("closed"));

    if (restart)
      return Promise.resolve(
        loaderFault("restart-required", { phase: error?.phase, entryIndex: error?.entryIndex }),
      );

    return refresh.reload();
  };

  const close = () => {
    if (!closing) {
      closed = true;
      watching.close();
      cache.clear();
      closing = Promise.all([app.close(), refresh.close()]).then(([result]) => result);
    }

    return closing;
  };

  const status = () => {
    let state: "open" | "closed" | "restart-required" = "open";

    if (closed) state = "closed";
    else if (restart) state = "restart-required";

    return Object.freeze({
      state,
      imports: count,
      maxImports: config.maxImports,
      ...(error ? { error } : {}),
    });
  };

  if (!(await syncWatch())) {
    await close();
    return fail("watch-failed", { phase: "watch" });
  }

  const initial = await reload();

  if (!initial.ok) {
    const closed = await close();
    return closed.ok ? initial : fail("restart-required", { phase: "close" });
  }

  if (config.watch) refresh.changed();

  return {
    ok: true,
    value: Object.freeze({
      reload,
      close,
      use: app.use,
      dispatch: app.dispatch,
      snapshot: () => app.snapshot(),
      inspect: () => app.inspect(),
      status,
    } satisfies Loader),
  };
}
