export { sessionStorage } from "./storage/define-storage";
export { defaultSessionLimits } from "./contracts/session-limits";
export type * from "./storage/types";
export { readStorageMetadata } from "./storage/read-metadata";

export { readStorageRequest, isStorageIdentifier, isStorageCount, isStorageText } from "./storage/read-storage-request";
export { readStoragePolicy, storagePolicyKeys } from "./storage/read-storage-policy";
export { createStorageQueue } from "./storage/create-storage-queue";
