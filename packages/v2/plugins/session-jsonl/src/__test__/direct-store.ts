import type { SessionStorage } from "../../../session/src/storage";
import { createFileIO } from "../create-file-io";
import { openJsonlStore } from "../open-store";
import { createJsonlStorage } from "../create-storage-service";
import { defaultJsonlLimits } from "../read-options";
import type { FileIO, JsonlLimits } from "../types";

export async function directStore(
  path: string,
  options: { io?: FileIO; signal?: AbortSignal; limits?: JsonlLimits } = {},
) {
  const store = await openJsonlStore(
    path,
    options.limits ?? defaultJsonlLimits,
    options.io ?? createFileIO(),
  );
  const service = createJsonlStorage(store);
  const signal = options.signal ?? new AbortController().signal;
  const storage = Object.fromEntries(
    Object.entries(service).map(([name, method]) => [
      name,
      (input: never) => method(input, { signal } as never),
    ]),
  ) as unknown as SessionStorage;
  return { store, storage };
}
