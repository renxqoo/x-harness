import { readData } from "../../../../core/src/validation";
import type { StoredSessionSummary, StoragePolicy } from "./types";
import type { SessionResult } from "../contracts/types";
import { isStorageIdentifier, isStorageCount, isStorageText } from "./read-storage-request";
import { readStorageMetadata } from "./read-metadata";
import { fail } from "../domain/fail";

export function readStorageSummary(
  raw: unknown,
  policy: StoragePolicy,
): SessionResult<StoredSessionSummary> {
  const read = readData(raw);

  if (
    !read.ok ||
    Object.keys(read.value).some((key) => !["id", "createdAt", "metadata", "parent"].includes(key))
  )
    return fail("storage-corrupt");

  const { id, createdAt, metadata } = read.value;

  if (
    !isStorageIdentifier(id) ||
    !isStorageCount(createdAt) ||
    !isStorageText(metadata, policy.maxMetadataBytes) ||
    !readStorageMetadata(metadata, policy.maxMetadataBytes).ok
  )
    return fail("storage-corrupt");

  let parent: StoredSessionSummary["parent"];

  if (read.value.parent !== undefined) {
    const parsed = readData(read.value.parent);

    if (
      !parsed.ok ||
      Object.keys(parsed.value).length !== 2 ||
      !isStorageIdentifier(parsed.value.id) ||
      parsed.value.id === id ||
      !isStorageCount(parsed.value.revision) ||
      parsed.value.revision > policy.maxRecords
    )
      return fail("storage-corrupt");

    parent = Object.freeze({ id: parsed.value.id, revision: parsed.value.revision });
  }

  return {
    ok: true,
    value: Object.freeze({ id, createdAt, metadata, ...(parent ? { parent } : {}) }),
  };
}
