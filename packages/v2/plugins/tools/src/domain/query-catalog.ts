import { readContribution } from "../contributions/read-contribution";
import type { CatalogEntry } from "../contributions/read-contribution";
import type { ToolContribution } from "../contributions/types";
import type { ToolsLimits, ToolsResult } from "../contracts/types";
import { fail } from "./fail";
interface Cell {
  current?: (entry: ToolContribution) => ToolsResult<void>;
}

function visitor(cell: Cell) {
  return (entry: ToolContribution): ToolsResult<void> =>
    cell.current ? cell.current(entry) : fail("closed");
}

export function queryCatalog(limits: ToolsLimits) {
  const entries = new Map<string, CatalogEntry>();
  let bytes = 0;
  let failure: ToolsResult<never> | undefined;
  const cell: Cell = {
    current(raw) {
      if (failure) return failure;

      const parsed = readContribution(raw);

      if (!parsed.ok) return (failure = parsed);

      const entry = parsed.value;

      if (entries.has(entry.tool.name)) return (failure = fail("name-conflict"));

      if (entries.size >= limits.maxTools || bytes + entry.bytes > limits.maxCatalogBytes)
        return (failure = fail("capacity-exceeded"));

      entries.set(entry.tool.name, entry);
      bytes += entry.bytes;
      return { ok: true, value: undefined };
    },
  };
  return {
    input: Object.freeze({ visit: visitor(cell) }),
    finish(): ToolsResult<readonly CatalogEntry[]> {
      cell.current = undefined;
      return (
        failure ?? {
          ok: true,
          value: Object.freeze(
            [...entries.values()].sort((a, b) => a.tool.name.localeCompare(b.tool.name)),
          ),
        }
      );
    },
    close() {
      cell.current = undefined;
    },
  };
}
