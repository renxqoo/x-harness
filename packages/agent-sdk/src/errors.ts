import { HUB_ERROR_CODES, hubError } from "./shared/errors.ts";
import type { HubErrorCode, HubErrorShape } from "./shared/errors.ts";

export const SDK_ERROR_CODES = HUB_ERROR_CODES;
export const sdkError = hubError;
export type SdkErrorCode = HubErrorCode;
export type SdkErrorShape = HubErrorShape;
export type SdkResult<T> = { ok: true; value: T } | { ok: false; reason: HubErrorShape };

export { errorOfCause, CodedError, isHubErrorShape } from "./shared/errors.ts";
export { isHubErrorShape as isSdkErrorShape } from "./shared/errors.ts";
