import { createSdkPins } from "./create-sdk-pins";

const key = Symbol.for("@x-harness/plugin-loader/sdk-fingerprints");

export function pinSdk(root: string, fingerprint: string): boolean {
  if (
    typeof root !== "string" ||
    !root ||
    root.length > 4096 ||
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  )
    return false;

  try {
    let descriptor = Object.getOwnPropertyDescriptor(globalThis, key);

    if (!descriptor) {
      Object.defineProperty(globalThis, key, {
        value: createSdkPins(),
        writable: false,
        configurable: false,
        enumerable: false,
      });
      descriptor = Object.getOwnPropertyDescriptor(globalThis, key)!;
    }

    if (!("value" in descriptor) || !descriptor.value || typeof descriptor.value.pin !== "function")
      return false;

    return (descriptor.value as ReturnType<typeof createSdkPins>).pin(root, fingerprint);
  } catch {
    return false;
  }
}
