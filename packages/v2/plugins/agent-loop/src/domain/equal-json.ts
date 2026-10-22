export function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;

  const a = Object.keys(left),
    b = Object.keys(right);
  return (
    a.length === b.length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equalJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}
