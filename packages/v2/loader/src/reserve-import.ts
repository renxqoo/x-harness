const key = Symbol.for("@x-harness/plugin-loader/import-budget");

function createBudget() {
  let used = 0;
  return Object.freeze({ reserve(this: void) { if (used >= 64) return false; used += 1; return true; } });
}

export function reserveImport(): boolean {
  let descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (!descriptor) {
    Object.defineProperty(globalThis, key, { value: createBudget(), writable: false, configurable: false, enumerable: false });
    descriptor = Object.getOwnPropertyDescriptor(globalThis, key)!;
  }
  if (!("value" in descriptor) || !descriptor.value || typeof descriptor.value.reserve !== "function") return false;
  return (descriptor.value as ReturnType<typeof createBudget>).reserve();
}
