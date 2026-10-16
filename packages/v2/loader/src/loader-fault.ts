import type { LoaderFault } from "./types";

export function loaderFault(code: LoaderFault["code"]): { readonly ok: false; readonly error: LoaderFault } {
  return { ok: false, error: Object.freeze({ source: "loader", code, message: code }) };
}
