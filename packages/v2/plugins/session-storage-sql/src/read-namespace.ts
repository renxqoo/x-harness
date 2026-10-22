import type { Query, NamespaceOptions } from "./types";
import type { SessionResult } from "../../session/src/contracts";
import { readStoragePolicy, storagePolicyKeys } from "../../session/src/storage";
import { fail } from "./fail";

export async function readNamespace(
  query: Query,
  namespace: string,
): Promise<SessionResult<NamespaceOptions>> {
  const rows = await query.all("SELECT settings FROM xh_session_namespaces WHERE namespace=$1", [
    namespace,
  ]);

  if (!rows.length) return fail("not-found");

  try {
    const settings = JSON.parse(rows[0]!.settings as string) as unknown;

    if (!Array.isArray(settings) || settings.length !== storagePolicyKeys.length)
      return fail("storage-corrupt");

    const result = readStoragePolicy(
      Object.fromEntries(storagePolicyKeys.map((key, i) => [key, settings[i]])),
    );
    return result.ok
      ? { ok: true, value: { namespace, limits: result.value } }
      : fail("storage-corrupt");
  } catch {
    return fail("storage-corrupt");
  }
}
