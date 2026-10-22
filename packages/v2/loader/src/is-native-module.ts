import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));

export function isNativeModule(specifier: string): boolean {
  if (!isBuiltin(specifier)) return false;

  try {
    return isBuiltin(Bun.resolveSync(specifier, directory));
  } catch {
    return false;
  }
}
