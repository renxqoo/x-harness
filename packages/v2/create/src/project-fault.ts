import type { CreateProjectFault } from "./types";
export function projectFault(code: CreateProjectFault["code"], directory?: string): { readonly ok: false; readonly error: CreateProjectFault } {
  return { ok: false, error: Object.freeze({ source: "create", code, message: code, ...(directory ? { directory } : {}) }) };
}
