export function readArray(raw: unknown, maximum: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(raw)) return; const length = Object.getOwnPropertyDescriptor(raw, "length")?.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || Object.is(length, -0) || length > maximum || Reflect.ownKeys(raw).length !== length + 1) return;
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) { const property = Object.getOwnPropertyDescriptor(raw, String(index)); if (!property || !("value" in property)) return; values.push(property.value); }
    return values;
  } catch { return; }
}
