import type { Query } from "./types";
export function textOrder(query: Query): string { return query.textCollation === "C" ? '"C"' : '"BINARY"'; }
