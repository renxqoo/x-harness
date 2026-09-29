import { statSync } from "node:fs";
import { join } from "node:path";

export interface GrepOptions {
  readonly rgPath?: string;
  readonly rgBinDir?: string;
}

export interface ResolveRgInput {
  readonly explicit?: string;
  readonly rgBinDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly which?: (command: string) => string | null;
}

export function resolveRg(input: ResolveRgInput): string | null {
  if (input.explicit !== undefined && input.explicit !== "") return input.explicit;
  const env = input.env ?? process.env;
  const fromEnv = env.X_HARNESS_RG_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const dir = input.rgBinDir;
  if (dir !== undefined && dir !== "" && isFile(join(dir, "rg"))) return join(dir, "rg");
  const which = input.which ?? ((command: string) => Bun.which(command));
  return which("rg");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
